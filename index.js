const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const REQUIRED_ENV = { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, CLAUDE_API_KEY };
for (const [key, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) {
    console.error(`❌ Шаардлагатай env variable дутуу байна: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ============================================================
// 1. FACEBOOK WEBHOOK VERIFICATION
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook амжилттай баталгаажлаа!");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook баталгаажилт амжилтгүй болсон");
  return res.sendStatus(403);
});

// ============================================================
// 2. МЕССЕЖ ХҮЛЭЭН АВАХ ENDPOINT
// ============================================================
app.post("/webhook", async (req, res) => {
  // Facebook 20 секундийн дотор 200 хүлээдэг — хариуг шууд буцаагаад,
  // боловсруулалтыг арын background-д хийнэ.
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body;
    if (body.object !== "page" || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const event of events) {
        handleEvent(event).catch((err) =>
          console.error("❌ handleEvent алдаа:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("❌ Webhook боловсруулалтын алдаа:", err.message);
  }
});

async function handleEvent(event) {
  const senderId = event?.sender?.id;
  if (!senderId) return;

  // Зөвхөн хэрэглэгчийн бичсэн текст мессежид хариулна.
  // delivery / read / echo events-ийг алгасна.
  if (event.delivery || event.read || event.message?.is_echo) return;
  const userMessage = event.message?.text;
  if (!userMessage) return;

  console.log(`📨 Мессеж ирлээ (${senderId}): "${userMessage}"`);

  await sendTypingIndicator(senderId);
  const reply = await getClaudeReply(userMessage);
  await sendMessage(senderId, reply);
}

// ============================================================
// 3. CLAUDE AI-ААС ХАРИУЛТ АВАХ
// ============================================================
async function getClaudeReply(userMessage) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system:
          "Та манай Facebook хуудасны туслах chatbot байна. " +
          "Монгол хэлээр товч, найрсаг хариулна уу. " +
          "Хэрэглэгчдэд мэдээлэл өгч, асуултад хариулж, тусална уу.",
        messages: [{ role: "user", content: userMessage }],
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 25000,
      }
    );

    const content = response.data?.content;
    const text = Array.isArray(content)
      ? content.find((c) => c.type === "text")?.text
      : null;

    if (!text) {
      console.error("❌ Claude хариулт хоосон:", JSON.stringify(response.data));
      return "Уучлаарай, одоогоор хариулах боломжгүй байна.";
    }
    return text;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Claude API алдаа:", JSON.stringify(detail));
    return "Уучлаарай, одоогоор хариулах боломжгүй байна. Түр хүлээнэ үү.";
  }
}

// ============================================================
// 4. FACEBOOK-РУУ МЕССЕЖ ИЛГЭЭХ
// ============================================================
async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/me/messages",
      {
        recipient: { id: recipientId },
        message: { text },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 15000,
      }
    );
    console.log(`✅ Хариулт илгээлээ (${recipientId})`);
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Мессеж илгээхэд алдаа:", JSON.stringify(detail));
  }
}

// ============================================================
// 5. "БИЧИЖ БАЙНА..." ИНДИКАТОР
// ============================================================
async function sendTypingIndicator(recipientId) {
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/me/messages",
      {
        recipient: { id: recipientId },
        sender_action: "typing_on",
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 10000,
      }
    );
  } catch (_error) {
    // Индикатор алдаа гарсан ч үргэлжлүүлнэ
  }
}

// ============================================================
// SERVER ЭХЛҮҮЛЭХ
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server ажиллаж байна: http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: /webhook`);
  console.log(`🤖 Model: ${CLAUDE_MODEL}`);
});
