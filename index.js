// index.js
const express = require("express");
const axios = require("axios");

// ======== 環境變數 ========
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY; // 你在 Render 的名字
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const app = express();
app.use(express.json()); // 這行很重要，才能讀到 ESP32 / LINE 傳來的 JSON

// ================== LINE Webhook 入口 ==================
app.post("/webhook", async (req, res) => {
  // 先回 200 給 LINE，避免超時
  res.status(200).send("OK");

  const events = req.body.events;
  if (!events || events.length === 0) return;

  for (const e of events) {
    if (e.type === "message" && e.message.type === "text") {
      try {
        await handleTextMessage(e);
      } catch (err) {
        console.error("handleTextMessage error:", err.response?.data || err);
      }
    }
  }
});

// 處理文字訊息（使用A1 / 取衣A1）
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();

  console.log(">>> LINE text:", text);

  // 使用 A1
  if (text.startsWith("使用")) {
    const machineId = text.replace("使用", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：使用A1");
    }

    try {
      await upsertMachine({
        machine_id: machineId,
        status: "waiting_start", // 等待開始運轉
        current_user: userId
      });
    } catch (err) {
      console.error("db use error:", err.response?.data || err);
      return replyMessage(replyToken, "寫入資料庫失敗，請稍後再試。");
    }

    return replyMessage(
      replyToken,
      `✅ 已登記你本次使用洗衣機 ${machineId}。開始運轉後會自動通知你。`
    );
  }

  // 取衣 A1
  if (text.startsWith("取衣")) {
    const machineId = text.replace("取衣", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：取衣A1");
    }

    try {
      const row = await getMachine(machineId);
      if (!row) {
        return replyMessage(
          replyToken,
          `找不到洗衣機 ${machineId} 的紀錄，請先輸入「使用${machineId}」。`
        );
      }

      if (row.current_user !== userId) {
        return replyMessage(
          replyToken,
          `❌ 登記這台洗衣機的不是你，無法釋放 ${machineId}。`
        );
      }

      await updateMachineToIdle(machineId);

      return replyMessage(
        replyToken,
        `✅ 已確認你已取走 ${machineId} 的衣物，機台已釋放。`
      );
    } catch (err) {
      console.error("db pickup error:", err.response?.data || err);
      return replyMessage(replyToken, "更新資料庫失敗，請稍後再試。");
    }
  }

  // 其他文字 → 顯示說明
  const help =
    "👋 智慧洗衣機系統（Supabase 版）\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1\n" +
    "「取衣A1」→ 取衣後釋放 A1\n";
  return replyMessage(replyToken, help);
}

// ================== ESP32 入口 ==================
// ESP32 會 POST 到： https://你的 render 網址 /esp32
// Body: { "machine_id": "A1", "status": "started" | "finished" }
app.post("/esp32", async (req, res) => {
  console.log(">>> ESP32 payload:", req.body);

  const { machine_id, status } = req.body || {};
  if (!machine_id || !status) {
    return res.status(400).json({ ok: false, error: "missing machine_id or status" });
  }

  try {
    const row = await getMachine(machine_id); // 先看目前資料庫狀態（拿 current_user）

    if (status === "started") {
      // ESP32 偵測到開始運轉 → 狀態改成 running
      await upsertMachine({
        machine_id,
        status: "running",
        current_user: row ? row.current_user : null
      });

      // 如果有綁定使用者，就私訊
      if (row && row.current_user) {
        await pushMessage(row.current_user, `🌀 你登記的洗衣機 ${machine_id} 已開始運轉。`);
      }

      console.log(`machine ${machine_id} -> running`);
    } else if (status === "finished") {
      // ESP32 偵測到洗完 → 狀態改成 finished_wait
      await upsertMachine({
        machine_id,
        status: "finished_wait",
        current_user: row ? row.current_user : null
      });

      if (row && row.current_user) {
        await pushMessage(
          row.current_user,
          `✅ 洗衣機 ${machine_id} 已完成，請盡速取衣。\n取衣後輸入「取衣${machine_id}」釋放機台。`
        );
      }

      console.log(`machine ${machine_id} -> finished_wait`);
    } else {
      console.log("unknown status from ESP32:", status);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("esp32 route error:", err.response?.data || err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

// ================== Supabase：共用函式 ==================
async function upsertMachine(row) {
  const now = new Date().toISOString();

  await axios.post(
    `${SUPABASE_REST_URL}/machines`,
    { ...row, updated_at: now },
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates" // machine_id 為 PK
      }
    }
  );
}

async function getMachine(machineId) {
  const resp = await axios.get(`${SUPABASE_REST_URL}/machines`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    },
    params: {
      machine_id: `eq.${machineId}`,
      select: "*"
    }
  });

  const data = resp.data;
  if (!data || data.length === 0) return null;
  return data[0];
}

async function updateMachineToIdle(machineId) {
  const now = new Date().toISOString();

  await axios.patch(
    `${SUPABASE_REST_URL}/machines`,
    {
      status: "idle",
      current_user: null,
      updated_at: now
    },
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      params: { machine_id: `eq.${machineId}` }
    }
  );
}

// ================== LINE API ==================
async function replyMessage(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const payload = {
    replyToken,
    messages: [{ type: "text", text }]
  };

  try {
    await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN
      }
    });
  } catch (err) {
    console.error("reply error:", err.response?.data || err);
  }
}

// push 給特定使用者（洗衣完成通知用）
async function pushMessage(to, text) {
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to,
    messages: [{ type: "text", text }]
  };

  try {
    await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN
      }
    });
  } catch (err) {
    console.error("push error:", err.response?.data || err);
  }
}

// ================== 啟動伺服器 ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
