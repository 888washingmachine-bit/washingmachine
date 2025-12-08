// index.js
const express = require("express");
const axios = require("axios");

// ========= 環境變數 =========
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const app = express();
app.use(express.json());

// ================== LINE Webhook ==================
app.post("/webhook", async (req, res) => {
  // 先回 200 給 LINE（避免 timeout）
  res.status(200).end();

  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === "message" && ev.message.type === "text") {
      console.log(">>> LINE text:", ev.message.text);
      try {
        await handleTextMessage(ev);
      } catch (err) {
        console.error("handleTextMessage error:", err.response?.data || err.message);
      }
    }
  }
});

// 處理使用者文字指令
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();

  // 指令：使用A1 / 使用 A1
  if (text.startsWith("使用")) {
    const machineId = text.replace("使用", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：使用A1");
    }

    // 登記使用者
    await upsertMachine({
      machine_id: machineId,
      status: "waiting_start",
      current_user: userId
    });

    return replyMessage(
      replyToken,
      `✅ 已登記你本次使用洗衣機 ${machineId}。\n偵測到開始運轉時會自動標記是你。`
    );
  }

  // 指令：取衣A1 / 取衣 A1
  if (text.startsWith("取衣")) {
    const machineId = text.replace("取衣", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：取衣A1");
    }

    const row = await getMachine(machineId);
    if (!row) {
      return replyMessage(replyToken, `找不到洗衣機 ${machineId} 的紀錄，請先輸入「使用${machineId}」。`);
    }

    if (row.current_user !== userId) {
      return replyMessage(
        replyToken,
        `❌ 登記這台洗衣機的人不是你，無法釋放 ${machineId}。`
      );
    }

    if (row.status !== "finished_wait") {
      return replyMessage(
        replyToken,
        `目前系統狀態不是「洗衣完成待取」，現在狀態是：${row.status}`
      );
    }

    // 改成 idle
    await updateMachineToIdle(machineId);

    await replyMessage(
      replyToken,
      `✅ 已確認你已取走 ${machineId} 的衣物，機台已釋放。`
    );

    await broadcastToAll(`洗衣機 ${machineId}：已空閒 ✅ 可以使用`);
    return;
  }

  // 其他文字：顯示說明
  const help =
    "👋 智慧洗衣機系統\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1\n" +
    "「取衣A1」→ 取衣後釋放 A1\n";
  return replyMessage(replyToken, help);
}

// ================== ESP32 上報入口 ==================
app.post("/esp32", async (req, res) => {
  res.status(200).json({ ok: true });

  const { machine_id, status } = req.body || {};
  console.log(">>> ESP32 payload:", req.body);

  if (!machine_id || !status) {
    console.log("ESP32 payload 缺少欄位");
    return;
  }

  try {
    const machine = await getMachine(machine_id);

    if (!machine) {
      // 若還沒有資料就先建一筆（沒有 current_user）
      await upsertMachine({
        machine_id,
        status,
        current_user: null
      });
      return;
    }

    if (status === "started") {
      // 洗衣開始
      await upsertMachine({
        machine_id,
        status: "running",
        current_user: machine.current_user
      });

      console.log(`machine ${machine_id} -> running`);

      if (machine.current_user) {
        await pushToUser(
          machine.current_user,
          `🌀 你登記的洗衣機 ${machine_id} 已開始運轉。`
        );
      }

      await broadcastToAll(`洗衣機 ${machine_id}：使用中（有人使用）`);
    } else if (status === "finished") {
      // 洗衣完成，等待取衣
      await upsertMachine({
        machine_id,
        status: "finished_wait",
        current_user: machine.current_user
      });

      console.log(`machine ${machine_id} -> finished_wait`);

      if (machine.current_user) {
        await pushToUser(
          machine.current_user,
          `✅ 洗衣機 ${machine_id} 已完成，請盡速取衣。`
        );
      }

      await broadcastToAll(`洗衣機 ${machine_id}：洗衣完成，等待取衣中（請勿占用）`);
    }
  } catch (err) {
    console.error("handle ESP32 error:", err.response?.data || err.message);
  }
});

// ================== Supabase 操作 ==================
async function upsertMachine(row) {
  const now = new Date().toISOString();

  await axios.post(
    `${SUPABASE_REST_URL}/machines`,
    { ...row, updated_at: now },
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      }
    }
  );
}

async function getMachine(machineId) {
  const resp = await axios.get(`${SUPABASE_REST_URL}/machines`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
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
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      params: {
        machine_id: `eq.${machineId}`
      }
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
    console.error("reply error:", err.response?.data || err.message);
  }
}

async function pushToUser(to, text) {
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

// 使用 LINE 官方的 broadcast API，會發給所有加好友的人
async function broadcastToAll(text) {
  const url = "https://api.line.me/v2/bot/message/broadcast";
  const payload = {
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
    console.error("broadcast error:", err.response?.data || err.message);
  }
}

// ================== 啟動伺服器 ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
