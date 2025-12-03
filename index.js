const express = require("express");
const axios = require("axios");

// 從環境變數讀取 LINE 的 Channel access token
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

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
      // 簡單做：回 echo 訊息
      const userText = e.message.text;
      const replyText = "你說的是：" + userText;
      await replyMessage(e.replyToken, replyText);
    }
  }
});

// 呼叫 LINE Reply API
async function replyMessage(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const payload = {
    replyToken,
    messages: [
      {
        type: "text",
        text
      }
    ]
  };

  await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN
    }
  });
}

// 啟動伺服器（Render 會設定 PORT 環境變數）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
