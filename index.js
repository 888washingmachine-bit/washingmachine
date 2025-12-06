// index.js
// ======================================
//  智慧洗衣機後端：LINE + ESP32 + Supabase
// ======================================

const express = require("express");
const axios = require("axios");

// ======== 環境變數 ========
// LINE
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const app = express();
app.use(express.json());

// =============================
// 1. LINE Webhook 入口 /webhook
// =============================
app.post("/webhook", async (req, res) => {
  // 先回 200，避免 LINE 超時
  res.status(200).send("OK");

  const events = req.body.events;
  if (!events || events.length === 0) return;

  for (const e of events) {
    if (e.type === "message" && e.message.type === "text") {
      try {
        await handleTextMessage(e);
      } catch (err) {
        console.error("handleTextMessage error:", err.response?.data || err.message);
      }
    }
  }
});

// =============================
// 2. ESP32 回報狀態入口 /esp32
// =============================
//  ESP32 要 POST JSON: { "machine_id": "A1", "status": "started" 或 "finished" }
app.post("/esp32", async (req, res) => {
  try {
    const { machine_id, status } = req.body || {};

    if (!machine_id || !status) {
      return res.status(400).json({ error: "machine_id 與 status 必填" });
    }

    console.log(">>> ESP32:", machine_id, status);

    const machine = await getMachine(machine_id); // 可能為 null
    const currentUser = machine ? machine.current_user : null;
    const adText = "今日優惠：出示此訊息飲料店 9 折！"; // 你可以隨時改

    if (status === "started") {
      // 更新資料庫：狀態 running，保留綁定的 current_user
      await upsertMachine({
        machine_id,
        status: "running",
        current_user: currentUser
      });

      if (currentUser) {
        await pushMessage(
          currentUser,
          `🌀 你登記的洗衣機 ${machine_id} 已開始運轉。`
        );
      }
    } else if (status === "finished") {
      // 更新資料庫：狀態 finished_wait
      await upsertMachine({
        machine_id,
        status: "finished_wait",
        current_user: currentUser
      });

      if (currentUser) {
        await pushMessage(
          currentUser,
          `✅ 洗衣機 ${machine_id} 已完成，請盡速取衣。\n${adText}\n取衣後請輸入「取衣${machine_id}」或按系統按鈕。`
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ESP32 endpoint error:", err.response?.data || err.message);
    return res.status(500).json({ error: "server error" });
  }
});

// ==================================
// 處理 LINE 文字訊息（使用 / 取衣）
// ==================================
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();

  console.log(">>> Receive text from LINE:", text);

  // 指令：使用A1 / 使用 A1
  if (text.startsWith("使用")) {
    const machineId = text.replace("使用", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：使用A1");
    }

    try {
      await upsertMachine({
        machine_id: machineId,
        status: "waiting_start",
        current_user: userId
      });
    } catch (err) {
      console.error("db use error:", err.response?.data || err.message);
      return replyMessage(replyToken, "寫入資料庫失敗，請稍後再試。");
    }

    return replyMessage(
      replyToken,
      `✅ 已登記你本次使用洗衣機 ${machineId}，感測器偵測到開始時會通知你。`
    );
  }

  // 指令：取衣A1 / 取衣 A1
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
      console.error("db pickup error:", err.response?.data || err.message);
      return replyMessage(replyToken, "更新資料庫失敗，請稍後再試。");
    }
  }

  // 其他文字：顯示說明
  const help =
    "👋 智慧洗衣機系統\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1\n" +
    "「取衣A1」→ 取衣後釋放 A1\n";
  return replyMessage(replyToken, help);
}

// ==================================
// Supabase：machines 資料表操作
// ==================================

// 新增 / 更新一筆機台紀錄（machine_id 為 PK）
async function upsertMachine(row) {
  const now = new Date().toISOString(); // UTC

  await axios.post(
    `${SUPABASE_REST_URL}/machines`,
    {
      ...row,
      updated_at: now
    },
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      }
    }
  );
}

// 取得某一台機器的紀錄
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

// 將某機器狀態改成 idle
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
      params: {
        machine_id: `eq.${machineId}`
      }
    }
  );
}

// ==================================
// LINE：回覆 / 推播訊息
// ==================================
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
    console.error("reply error:", err.response?.data || err.message);
  }
}

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
    console.error("push error:", err.response?.data || err.message);
  }
}

// ==================================
// 啟動伺服器
// ==================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
