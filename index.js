const express = require("express");
const axios = require("axios");

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;

const app = express();
app.use(express.json());

// LINE Webhook 入口
app.post("/webhook", async (req, res) => {
  // 一定要先回 200，LINE Verify 才會成功
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

    // 呼叫 Apps Script，請它寫入「waiting_start」
    try {
      await axios.post(SHEET_WEBAPP_URL, {
        action: "use",
        userId,
        machineId
      });
    } catch (err) {
      console.error("sheet use error:", err.response?.data || err.message);
      return replyMessage(replyToken, "寫入試算表失敗，請稍後再試。");
    }

    return replyMessage(
      replyToken,
      `✅ 已登記你本次使用洗衣機 ${machineId}，資料已寫入試算表。`
    );
  }

  // 指令：取衣A1 / 取衣 A1
  if (text.startsWith("取衣")) {
    const machineId = text.replace("取衣", "").trim();
    if (!machineId) {
      return replyMessage(replyToken, "請輸入機台編號，例如：取衣A1");
    }

    // 呼叫 Apps Script，請它檢查 userId 並釋放
    try {
      await axios.post(SHEET_WEBAPP_URL, {
        action: "pickup",
        userId,
        machineId
      });
    } catch (err) {
      console.error("sheet pickup error:", err.response?.data || err.message);
      return replyMessage(replyToken, "更新試算表失敗，請稍後再試。");
    }

    return replyMessage(
      replyToken,
      `✅ 已送出取衣確認，若紀錄是你，洗衣機 ${machineId} 將被釋放。`
    );
  }

  // 其他文字：顯示說明
  const help =
    "👋 智慧洗衣機系統（Apps Script + Sheet）\n" +
    "指令示例：\n" +
    "「使用A1」→ 登記你正在使用 A1（寫入 machines 工作表）\n" +
    "「取衣A1」→ 取衣後釋放 A1（若紀錄使用者是你）\n";
  return replyMessage(replyToken, help);
}

// 呼叫 LINE Reply API
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

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
