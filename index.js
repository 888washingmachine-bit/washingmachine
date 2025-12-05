const express = require("express");
const axios = require("axios");

// 從環境變數讀設定
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY; // 用 SERVICE_KEY
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const app = express();
app.use(express.json());

// ========= LINE Webhook 入口 =========
app.post("/webhook", async (req, res) => {
  // 一定要先回 200，LINE 才不會當成失敗
  res.status(200).send("OK");

  const events = req.body.events;
  if (!events || events.length === 0) return;

  for (const e of events) {
    if (e.type === "message" && e.message.type === "text") {
      try {
        await handleTextMessage(e);
      } catch (err) {
        console.error("handleTextMessage error:", err);
      }
    }
  }
});

// ========= 處理文字訊息 =========
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
      `✅ 已登記你本次使用洗衣機 ${machineId}（資料已寫入資料庫）。`
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
    "👋 智慧洗衣機系統（Supabase 版）\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1\n" +
    "「取衣A1」→ 取衣後釋放 A1\n";
  return replyMessage(replyToken, help);
}

// ========= Supabase：資料庫操作 =========

// 新增 / 更新一筆機台紀錄（同一個 machine_id 只會存在一列）
async function upsertMachine(row) {
  await axios.post(`${SUPABASE_REST_URL}/machines`, row, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates" // machine_id 是 primary key
    }
  });
}

// 取某一台機器的紀錄
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
  await axios.patch(
    `${SUPABASE_REST_URL}/machines`,
    {
      status: "idle",
      current_user: null
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

// ========= LINE Reply API =========
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

// ========= 啟動伺服器 =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
