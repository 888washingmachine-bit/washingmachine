const express = require("express");
const axios = require("axios");

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const app = express();
app.use(express.json());

// 用記憶體暫存機台狀態（之後可以改成 Google Sheet）
const machines = {}; 
// 例如：machines["A1"] = { status: "finished_wait", userId: "Uxxxx" };

app.post("/webhook", async (req, res) => {
  // 先回 200 給 LINE
  res.status(200).send("OK");

  const events = req.body.events;
  if (!events || events.length === 0) return;

  for (const e of events) {
    if (e.type === "message" && e.message.type === "text") {
      await handleTextMessage(e);
    }
  }
});

// 處理文字訊息
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
    machines[machineId] = { status: "waiting_start", userId };
    return replyMessage(
      replyToken,
      `✅ 已登記你本次使用洗衣機 ${machineId}，開始運轉時會標記是你。`
    );
  }

  // 指令：取衣A1 / 取衣 A1
  if (text.startsWith("取衣")) {
    const machineId = text.replace("取衣", "").trim();
    const m = machines[machineId];
    if (!m) {
      return replyMessage(
        replyToken,
        `❌ 找不到洗衣機 ${machineId} 的紀錄。請先使用「使用${machineId}」登記。`
      );
    }

    // 這裡暫時不檢查 finished_wait，只檢查是不是同一個 user
    if (m.userId !== userId) {
      return replyMessage(
        replyToken,
        `❌ 目前登記的使用者不是你，無法釋放洗衣機 ${machineId}。`
      );
    }

    machines[machineId] = { status: "idle", userId: null };
    return replyMessage(
      replyToken,
      `✅ 已確認你已取走 ${machineId} 的衣物，機台已釋放。`
    );
  }

  // 其他訊息：顯示說明
  const help =
    "👋 歡迎使用智慧洗衣通知系統（Node.js 版）\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1\n" +
    "「取衣A1」→ 取衣後釋放 A1\n";
  return replyMessage(replyToken, help);
}

// 回覆 LINE
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
