const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ============================================================
// 1. FACEBOOK WEBHOOK VERIFICATION
// Facebook шинэ webhook бүртгэхдээ энэ endpoint-г шалгадаг
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook амжилттай баталгаажлаа!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook баталгаажилт амжилтгүй болсон");
    res.sendStatus(403);
  }
});

// ============================================================
// 2. МЕССЕЖ ХҮЛЭЭН АВАХ ENDPOINT
// Хэрэглэгч мессеж илгээх бүрт Facebook энд дуудна
// ============================================================
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Facebook олон мессежийг нэг хүсэлтэд илгээж болно
  for (const entry of body.entry) {
    const webhookEvent = entry.messaging[0];
    const senderId = webhookEvent.sender.id;

    console.log(`📨 Мессеж ирлээ: ${senderId}`);

    if (webhookEvent.message && webhookEvent.message.text) {
      const userMessage = webhookEvent.message.text;
      console.log(`💬 Агуулга: "${userMessage}"`);

      // "Бичиж байна..." индикатор харуулах
      await sendTypingIndicator(senderId);

      // Claude-аас хариулт авч илгээх
      const reply = await getClaudeReply(userMessage);
      await sendMessage(senderId, reply);
    }
  }

  // Facebook 200 хариулт хүлээдэг, үгүй бол дахин дамжуулна
  res.status(200).send("EVENT_RECEIVED");
});

// ============================================================
// 3. CLAUDE AI-ААС ХАРИУЛТ АВАХ
// ============================================================
async function getClaudeReply(userMessage) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: `Та манай Facebook хуудасны туслах chatbot байна. 
Монгол хэлээр товч, найрсаг хариулна уу.
Хэрэглэгчдэд мэдээлэл өгч, асуултад хариулж, тусалж байна.`,
        messages: [{ role: "user", content: userMessage }],
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error("❌ Claude API алдаа:", error.message);
    return "Уучлаарай, одоогоор хариулах боломжгүй байна. Түр хүлээнэ үү.";
  }
}

// ============================================================
// 4. FACEBOOK-РУУ МЕССЕЖ ИЛГЭЭХ
// ============================================================
async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: text },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
      }
    );
    console.log(`✅ Хариулт илгээлээ: "${text.substring(0, 50)}..."`);
  } catch (error) {
    console.error("❌ Мессеж илгээхэд алдаа:", error.response?.data || error.message);
  }
}

// ============================================================
// 5. "БИЧИЖ БАЙНА..." ИНДИКАТОР
// ============================================================
async function sendTypingIndicator(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        sender_action: "typing_on",
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
      }
    );
  } catch (error) {
    // Индикатор алдаа гарсан ч үргэлжлүүлнэ
  }
}

// ============================================================
// SERVER ЭХЛҮҮЛЭХ
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server ажиллаж байна: http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
});
