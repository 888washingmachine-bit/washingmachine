import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// 從環境變數讀取設定
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PORT = process.env.PORT || 3000;

// ---- 測試用 ----
app.get("/", (req, res) => {
  res.send("OK from Render");
});

// ---- Webhook ----
app.post("/", (req, res) => {
  try {
    const body = req.body;
    console.log("Webhook received:", JSON.stringify(body));

    // LINE 驗證 webhook 時會送空 body，所以直接回 200
    res.status(200).send("OK");

  } catch (err) {
    console.error(err);
    res.status(200).send("OK");
  }
});

// ---- 啟動 ----
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
