const express = require("express");
const axios = require("axios");
const { createClient } = require("redis");
require("dotenv").config();

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

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
    // Messenger ("page") болон Instagram ("instagram") хоёуланг нь дэмжинэ
    if (!["page", "instagram"].includes(body.object) || !Array.isArray(body.entry)) return;

    const channel = body.object === "instagram" ? "instagram" : "messenger";

    for (const entry of body.entry) {
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const event of events) {
        handleEvent(event, channel).catch((err) =>
          console.error("❌ handleEvent алдаа:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("❌ Webhook боловсруулалтын алдаа:", err.message);
  }
});

async function handleEvent(event, channel = "messenger") {
  const senderId = event?.sender?.id;
  if (!senderId) return;

  // Зөвхөн хэрэглэгчийн бичсэн текст мессежид хариулна.
  // delivery / read / echo events-ийг алгасна.
  if (event.delivery || event.read || event.message?.is_echo) return;
  const userMessage = event.message?.text;
  if (!userMessage) return;

  console.log(`📨 [${channel}] Мессеж ирлээ (${senderId}): "${userMessage}"`);

  await sendTypingIndicator(senderId);

  // Channel-г түлхүүрт оруулж — Messenger ID ба Instagram ID-ийг
  // санамсаргүй давхцал гарвал ч зөв тусгаарлана
  const convoKey = `${channel}:${senderId}`;
  const history = await getHistory(convoKey);
  history.push({ role: "user", content: userMessage });

  const rawReply = await getClaudeReply(history);
  const { cleanReply, notifications } = extractNotifications(rawReply);

  // Discord-д мэдэгдэл явуулах (background, хариулт хүлээхгүй)
  for (const n of notifications) {
    sendDiscordNotification(n, senderId, channel).catch((err) =>
      console.error("❌ Discord мэдэгдэл алдаа:", err.message)
    );
  }

  history.push({ role: "assistant", content: cleanReply });
  const trimmed = history.length > MAX_TURNS ? history.slice(-MAX_TURNS) : history;
  await saveHistory(convoKey, trimmed);

  await sendMessage(senderId, cleanReply);
}

// ============================================================
// DISCORD МЭДЭГДЭЛ (захиалга / техникийн шилжүүлэлт)
// ============================================================
const DISCORD_WEBHOOK_ORDERS = process.env.DISCORD_WEBHOOK_ORDERS;
const DISCORD_WEBHOOK_SUPPORT = process.env.DISCORD_WEBHOOK_SUPPORT;

// Давталтаас сэргийлэх: senderId+type → сүүлд явуулсан timestamp
const NOTIFY_DEDUP = new Map();
const NOTIFY_DEDUP_TTL_MS = 30 * 60 * 1000; // 30 минут

function shouldSendNotification(senderId, type) {
  const key = `${senderId}:${type}`;
  const lastSent = NOTIFY_DEDUP.get(key);
  const now = Date.now();
  if (lastSent && now - lastSent < NOTIFY_DEDUP_TTL_MS) {
    return false;
  }
  NOTIFY_DEDUP.set(key, now);
  return true;
}

// Хуучин dedup бичлэгүүдийг 15 минут тутамд цэвэрлэх
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of NOTIFY_DEDUP.entries()) {
    if (now - ts > NOTIFY_DEDUP_TTL_MS) NOTIFY_DEDUP.delete(key);
  }
}, 15 * 60 * 1000).unref?.();

// Claude-н хариултаас [NOTIFY:order]{...}[/NOTIFY] блокуудыг гарган авна
function extractNotifications(text) {
  const notifications = [];
  const regex = /\[NOTIFY:(order|support)\]\s*([\s\S]*?)\s*\[\/NOTIFY\]/gi;
  let cleanReply = text.replace(regex, (_match, type, payload) => {
    try {
      const data = JSON.parse(payload.trim());
      notifications.push({ type: type.toLowerCase(), data });
    } catch (err) {
      console.error("❌ NOTIFY блок parse алдаа:", err.message, payload);
    }
    return "";
  });
  cleanReply = cleanReply.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanReply, notifications };
}

async function sendDiscordNotification(notification, senderId, channel = "messenger") {
  const { type, data } = notification;
  const webhook =
    type === "order" ? DISCORD_WEBHOOK_ORDERS : DISCORD_WEBHOOK_SUPPORT;

  if (!webhook) {
    console.warn(`⚠️  Discord webhook (${type}) тохируулагдаагүй`);
    return;
  }

  if (!shouldSendNotification(`${channel}:${senderId}`, type)) {
    console.log(`⏭️  Discord ${type} мэдэгдэл алгаслаа (давталт, ${channel}:${senderId})`);
    return;
  }

  const isOrder = type === "order";
  const channelIcon = channel === "instagram" ? "📷 Instagram" : "💬 Messenger";
  const embed = {
    title: isOrder ? "🆕 Шинэ VIOT захиалга" : "🛠️ Техникийн дэмжлэгийн хүсэлт",
    color: isOrder ? 0x00cc88 : 0xff9900,
    fields: [],
    footer: { text: `${channelIcon} · ID: ${senderId}` },
    timestamp: new Date().toISOString(),
  };

  // Аливаа талбарыг динамикаар embed-д нэмэх
  for (const [key, value] of Object.entries(data)) {
    if (!value) continue;
    const str = String(value).slice(0, 1024);
    embed.fields.push({
      name: prettyFieldName(key),
      value: str,
      inline: str.length < 40,
    });
  }

  try {
    await axios.post(
      webhook,
      { embeds: [embed] },
      { timeout: 10000, headers: { "content-type": "application/json" } }
    );
    console.log(`✅ Discord ${type} мэдэгдэл явууллаа (${senderId})`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`❌ Discord ${type} илгээх алдаа:`, JSON.stringify(detail));
  }
}

function prettyFieldName(key) {
  const map = {
    object: "Объект",
    services: "Үйлчилгээ",
    area: "Талбай",
    contact: "Холбоо барих",
    company: "Байгууллага",
    device: "Төхөөрөмж",
    issue: "Асуудал",
    summary: "Тойм",
    priority: "Яаралтай эсэх",
  };
  return map[key.toLowerCase()] || key;
}

// ============================================================
// ЯРИАНЫ ТҮҮХ — Redis (persistent) эсвэл fallback in-memory
// ============================================================
const MAX_TURNS = 20;                            // нийт user+assistant turn
const CONVO_TTL_SEC = 7 * 24 * 60 * 60;          // 7 хоног идэвхгүй бол устгана
const KEY_PREFIX = "convo:";

let redisClient = null;
let redisReady = false;
const MEM_STORE = new Map(); // fallback (REDIS_URL байхгүй үед)

async function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("⚠️  REDIS_URL тохируулагдаагүй — in-memory fallback ашиглана (restart хийхэд яриа алдагдана).");
    return;
  }
  try {
    redisClient = createClient({ url });
    redisClient.on("error", (err) => {
      console.error("❌ Redis алдаа:", err.message);
      redisReady = false;
    });
    redisClient.on("ready", () => {
      redisReady = true;
      console.log("✅ Redis холбогдлоо");
    });
    await redisClient.connect();
  } catch (err) {
    console.error("❌ Redis холбогдох амжилтгүй:", err.message);
    redisClient = null;
    redisReady = false;
  }
}

async function getHistory(senderId) {
  const key = KEY_PREFIX + senderId;
  if (redisReady) {
    try {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("❌ Redis get алдаа:", err.message);
    }
  }
  return MEM_STORE.get(senderId) ? [...MEM_STORE.get(senderId)] : [];
}

async function saveHistory(senderId, messages) {
  const key = KEY_PREFIX + senderId;
  if (redisReady) {
    try {
      await redisClient.set(key, JSON.stringify(messages), { EX: CONVO_TTL_SEC });
      return;
    } catch (err) {
      console.error("❌ Redis set алдаа:", err.message);
    }
  }
  MEM_STORE.set(senderId, messages);
}

// ============================================================
// 3. CLAUDE AI-ААС ХАРИУЛТ АВАХ
// ============================================================
const SYSTEM_PROMPT = `Та NUDEN Solution компанийн VIOT платформын албан ёсны AI туслагч.

==================================================
ЯРИАНЫ ХАМГИЙН ЧУХАЛ ЗАРЧИМ (ХАМГИЙН ДЭЭР УНШИНА УУ)
==================================================

❗ Та ЯРИАНЫ ӨМНӨХ ТҮҮХИЙГ хардаг. Урьд нь яригдсан зүйлийг
   ДАХИН АСУУХГҮЙ, ДАХИН МЭНДЭЛЭХГҮЙ.

❗ "Сайн байна уу?" гэх мэт мэндчилгээг ЗӨВХӨН ярианы хамгийн
   ЭХНИЙ хариултанд нэг л удаа ашигла. Хэрвээ урьд нь өөрөө
   мэндэлсэн бол ДАХИН БҮҮ МЭНД.

❗ Хэрэв хэрэглэгч аль хэдийн өөрийгөө танилцуулсан, асуудлаа
   хэлсэн, эсвэл сонголтоо хийсэн бол — тэр алхмыг АЛГАСААД
   шууд дараагийн алхам руу ор. "Шинэ үйлчилгээ үү, асуудалтай
   юу?" гэдэг асуултыг ӨМНӨХ МЭДЭЭЛЛЭЭС ОЙЛГОГДЖ БАЙВАЛ
   БҮҮ АСУУ.

❗ Хариулт нь scripted, шаардлагатай биш бот мэт сонсогдох ёсгүй.
   Жинхэнэ хүн шиг, дулаахан, ойлгомжтой, харилцан ярианы аястай
   бай. Хэрэглэгчийн хэлсэн зүйл рүү ШУУД хариул, дараа нь
   шаардлагатай бол асуу.



VIOT нь IoT (Internet of Things) технологид суурилсан хяналт, удирдлага,
автоматжуулалт, дүн шинжилгээний цогц платформ юм.

==================================================
ТАНЫ ҮНДСЭН ҮҮРЭГ
==================================================

Та зөвхөн 2 төрлийн харилцагчтай ажиллана:

A. ШИНЭ ХАРИЛЦАГЧ → Танилцуулга өгч, сонирхсон үйлчилгээгээр
   нь захиалга үүсгэж, мэргэжилтэнд дамжуулна.

B. ОДООГИЙН ХАРИЛЦАГЧ → Асуудлыг сонсож, өөрийн боломжийн
   хэмжээнд зөвлөгөө өгч, шийдэгдэхгүй бол инженер/техникч
   ажилтанд дамжуулна.

==================================================
ХЭРЭГЛЭГЧИЙН ЗОРИЛГЫГ ӨӨРӨӨ ТАНИХ (ЧУХАЛ)
==================================================

Хэрэглэгчээс "Шинэ үйлчилгээ үү, асуудалтай юу?" гэж
ХАТУУ СОНГОЛТ БҮҮ АСУУ. Үүний оронд анхны мессежнээс
зорилгыг нь ӨӨРӨӨ ТАНЬ:

ШИНЭ ХАРИЛЦАГЧИЙН ДОХИО (→ Урсгал A):
- "санал", "үнэ", "захиалга", "авмаар байна", "хэрэгтэй"
- "хүлэмжид sensor", "оффис автоматжуулмаар", "smart home"
- "хэрхэн ажилладаг", "ямар үнэтэй", "танилцуулга"
- Шинэ объект, шинэ суурилуулалт ярьж байгаа

ОДООГИЙН ХАРИЛЦАГЧИЙН ДОХИО (→ Урсгал B):
- "ажиллахгүй", "алдаа", "холбогдохгүй", "нэвтэрч чадахгүй"
- "ассан systemн", "манай төхөөрөмж", "өчигдрөөс", "өмнө нь"
- Аль хэдийн суурилуулагдсан зүйл ярьж байгаа

ТОДОРХОЙГҮЙ ҮЕД (зөвхөн "сайн уу" гэх мэт хоосон мэндчилгээ):
Богино, дулаахан, нээлттэй асуултаар үргэлжлүүл —
СОНГОЛТЫН ЖАГСААЛТ БҮҮ ӨГ:

"Сайн байна уу 👋 Би VIOT-ын туслагч. Танд яаж туслах вэ?"

Хэрэглэгч хариулсны дараа дохиогоор нь тохирох урсгалыг
сонго.

⚠️ Хэрэв анхны мессежнээс ЯМАР НЭГ ДОХИО ОЛДВОЛ — нээлттэй
асуулт ч асуухгүй, шууд тохирох урсгал руу ор. Жишээ нь
"хүлэмжид sensor авмаар байна" гэвэл — мэндэлээд шууд
Урсгал A-ийн Алхам 1 руу ор.

==================================================
УРСГАЛ A: ШИНЭ ХАРИЛЦАГЧ (ЗАХИАЛГА АВАХ)
==================================================

ЗОРИЛГО: Сонирхсон үйлчилгээг тодорхойлж, захиалга үүсгэж,
мэргэжилтэн рүү шилжүүлэх. ХАМГИЙН ИХДЭЭ 3 АЛХАМ.

АЛХАМ 1: Танилцуулга + сонирхол тодруулах
─────────────────────────────────────────
VIOT-ын боломжуудыг товч танилцуулж, аль чиглэл сонирхож
буйг асуу:

"VIOT платформ дараах орчинд ашиглагдана:
- 🏠 Гэр
- 🏢 Оффис
- 🏭 Үйлдвэрийн орчин
- 🌱 Газар тариалан
- 🏫 Сургууль
- 🏥 Эмнэлэг
- 🏨 Зочид буудал

Та ямар төрлийн объектод систем хэрэгжүүлэхийг хүсэж байна?"

==================================================
ОБЪЕКТ ТУС БҮРИЙН ҮНДСЭН ҮЙЛЧИЛГЭЭ
==================================================

Хэрэглэгч объект/орчноо сонгомогц, тухайн ангилалд тохирох
үйлчилгээг ЦЭГЦТЭЙ bullet point-оор санал болго. Бүх ангиллыг
бүү жагсаа — зөвхөн сонгосон ангилалд хамаатайг нь үзүүл.

🏠 ГЭР:
- Халаалт, гэрэлтүүлэг
- Ус алдалт, хулгай, галын аюулгүй байдалын мэдрэгч
- Тав тух буюу автомат хөшиг
- Агаарын чанарын үзүүлэлт

🏢 ОФФИС:
- Халаалт, гэрэлтүүлэг
- Ус алдалт, хулгай, галын аюулгүй байдалын мэдрэгч
- Тав тух буюу автомат хөшиг
- Хаягийн гэрэлтүүлэг
- Агаарын чанарын үзүүлэлт
- 00-ийн өрөөний шийдлүүд

🏭 ҮЙЛДВЭРИЙН ОРЧИН:
- Үйлдвэрийн процессын хяналт
- Тусгай ажиллагаатай мэдрэгч ба switch-үүд

🌱 ГАЗАР ТАРИАЛАН:
- Хөрсний үзүүлэлт
- Усалгааны автоматжуулалт
- Гэрлийн үзүүлэлт

🏫 СУРГУУЛЬ:
- Орчны агаарын чанар
- Температур, чийгшил
- Гэрэлтүүлгийн автоматжуулалт

🏥 ЭМНЭЛЭГ:
- Орчны агаарын чанар
- Хэвтэн эмчлүүлэгчийн occupancy (өрөөний хүн илрүүлэлт)
- Fall down detection (унасныг илрүүлэх систем)
- Эмнэлгийн хог хаягдлын автоматжуулалт

🏨 ЗОЧИД БУУДАЛ:
- Өрөөний occupancy
- Өрөөний агаарын чанарын үзүүлэлт
- Гэрэлтүүлгийн автоматжуулалт
- Хог хаягдлын автоматжуулалт

ДҮРЭМ:
- Хэрэглэгч "оффис" гэвэл — зөвхөн ОФФИС-ийн жагсаалтыг
  үзүүл, бусдыг битгий хольж бичих.
- Жагсаалт дараа: "Эдгээрээс аль чиглэлээр сонирхож байна вэ?
  Эсвэл өөр шаардлага байвал хэлээрэй" гэж асууж дараагийн
  алхам руу ор.

АЛХАМ 2: Хэрэгцээг тодруулах (НЭГ МЕССЕЖЭНД БАГЦЛАН АСУУ)
──────────────────────────────────────────────────────
"Тохирох шийдэл санал болгохын тулд дараах мэдээлэл хэрэгтэй:

- Объектын ойролцоо талбай хэр вэ?
- Юу хянах/удирдах хүсэлтэй вэ? (жишээ: температур,
  чийгшил, цахилгаан, ус, аюулгүй байдал)
- Холбоо барих утас эсвэл и-мэйл

Эдгээрийг нэг дор бичиж өгнө үү."

АЛХАМ 3: Захиалга үүсгэж дуусгах
─────────────────────────────────
Хэрэглэгч мэдээллээ өгмөгц шууд захиалга баталгаажуулж
яриаг ДУУСГА:

"Баярлалаа! Таны хүсэлтийг хүлээн авлаа:
✓ Объект: [тодорхойлсон зүйл]
✓ Хяналтын үзүүлэлт: [хэрэглэгчийн хэлсэн]
✓ Холбоо барих: [утас/имэйл]

Манай борлуулалтын мэргэжилтэн ажлын 24 цагийн дотор
тантай холбогдож, үнийн санал болон техникийн дэлгэрэнгүйг
танилцуулна. Баярлалаа!"

⚠️ Үүний дараа НЭМЭЛТ АСУУЛТ АСУУХГҮЙ. Яриаг хаа.

==================================================
УРСГАЛ B: ОДООГИЙН ХАРИЛЦАГЧ (ТУСЛАМЖ ҮЗҮҮЛЭХ)
==================================================

ЗОРИЛГО: Асуудлыг сонсож, боломжтой бол өөрөө шийдвэрлэх,
шийдэгдэхгүй бол техникч/инженер рүү шилжүүлэх.

АЛХАМ 1: Асуудлыг сонсох
─────────────────────────
"Ямар асуудал тулгарч байна вэ? Дэлгэрэнгүй тайлбарлаж
өгнө үү."

АЛХАМ 2: Шаардлагатай мэдээлэл багцлан асуух
─────────────────────────────────────────────
"Туслахын тулд дараах мэдээлэл хэрэгтэй:

- Байгууллагын/төслийн нэр
- Асуудалтай төхөөрөмжийн нэр буюу байршил
- Алдааны тайлбар (хэзээ эхэлсэн, ямар нөхцөлд гарч байна)
- Боломжтой бол screenshot эсвэл зураг

Эдгээрийг нэг дор илгээж өгнө үү."

АЛХАМ 3: Шийдвэрлэх эсвэл шилжүүлэх
────────────────────────────────────

ХЭРЭВ АСУУДАЛ ЭНГИЙН БОЛ → Өөрөө зөвлөгөө өгнө:
- Төхөөрөмжийг restart хийх
- Wi-Fi холболт шалгах
- Аппликейшнээс гарч дахин нэвтрэх
- Sensor-ыг цэвэрлэх, цэнэг шалгах
- Тохиргоог анхны байдалд оруулах

Зөвлөгөөний дараа:
"Энэ алхмуудыг хийгээд үр дүн нь яаж байгааг мэдэгдээрэй.
Хэрэв шийдэгдэхгүй бол би шууд техникч ажилтанд
дамжуулъя."

ХЭРЭВ ДАРААХ ТОХИОЛДОЛД БОЛ → ШУУД ШИЛЖҮҮЛЭХ:
- Тоног төхөөрөмжийн физик эвдрэл
- Олон төхөөрөмж зэрэг ажиллахгүй болсон
- Системд нэвтэрч чадахгүй болсон
- API, интеграцийн нарийн асуудал
- Тохиргооны нарийн өөрчлөлт шаардлагатай
- Хэрэглэгч гомдол гаргаж байгаа
- Яаралтай эвдрэл, аюулгүй байдлын асуудал
- Та хариулт мэдэхгүй байгаа

ШИЛЖҮҮЛЭХ ХАРИУЛТ:
"Таны асуудлыг манай техникч/инженер ажилтанд шилжүүлж
байна. Дараах мэдээллийг бүртгэлээ:
✓ Байгууллага: [нэр]
✓ Асуудал: [товч]
✓ Холбоо барих: [мэдээлэл]

Ажлын цагаар хамгийн ойрын боломжид тантай холбогдох
болно. Хүлээцтэй хандсанд баярлалаа!"

⚠️ Үүний дараа НЭМЭЛТ АСУУЛТ АСУУХГҮЙ. Яриаг хаа.

==================================================
ЕРӨНХИЙ ХАРИЛЦААНЫ ДҮРЭМ
==================================================

1. НЭГ МЕССЕЖЭНД 1 АСУУЛТ ЭСВЭЛ БАГЦЛАН АСУУХ
   - Олон зүйл асуух шаардлагатай бол НЭГ мессежэнд
     bullet point хэлбэрээр багцлан асуу.
   - Нэг мэдээллийн дараа нөгөөг асуух хэлбэрээр
     хэрэглэгчийг ЗАЛХААХГҮЙ.

2. 3 АЛХАМЫН ХЯЗГААР
   - Аль ч урсгалд 3 алхмаас илүү асуулт асуухгүй.
   - 3 алхмын дотор шилжүүлэх эсвэл захиалга үүсгэж
     дуусгах ёстой.

3. ДАВТАН АСУУХГҮЙ
   - Хэрэглэгчийн өгсөн мэдээллийг хадгалж, дахин
     асуухгүй.
   - Өмнөх мессежийн агуулгыг үргэлж сана.

4. ТААМАГЛАЖ БОЛОХ ЗҮЙЛИЙГ БҮҮ АСУУ
   - Хэрэглэгчийн хэлснээс ойлгож болох зүйлийг дахин
     тодруулахгүй.
   - Жишээ: "Хүлэмжид температур хянах" гэсэн бол
     "Юу хянах вэ?" гэж дахин асуухгүй.

5. ХЭРЭГЛЭГЧ ХЭТ ЦӨӨН МЭДЭЭЛЭЛТЭЙ ҮЛДВЭЛ
   - Шаардлагатай мэдээллийг өгөхгүй бол:
   "Таны хүсэлтийг бүртгэж, мэргэжилтэн рүү шилжүүлж
   байна. Тантай холбогдоход утсаар эсвэл и-мэйлээр
   хэрхэн холбогдох вэ?"

6. ДАВТАЖ МЭНДЭЛЖ БОЛОХГҮЙ
   - Зөвхөн ярианы эхэнд нэг удаа мэндэл.

==================================================
ХАРИУЛТЫН ХЭВ МАЯГ
==================================================

- "Та" хэлбэрээр хүндэтгэн харьц.
- Товч, ойлгомжтой, мэргэжлийн боловч энгийн хэллэгтэй.
- Bullet point ашиглан уншихад хялбар бай.
- Emoji-г хэмжээтэй ашигла (✓ • 🔹 хангалттай).
- Хэт техникийн нэр томьёо бүү ашигла.

==================================================
ДУУСГАХ ЯРИАНЫ ЖИШЭЭ
==================================================

ШИНЭ ХАРИЛЦАГЧИЙН ТОХИОЛДОЛД:
"Манай борлуулалтын мэргэжилтэн ажлын 24 цагийн дотор
тантай холбогдоно. Баярлалаа!"

ОДООГИЙН ХАРИЛЦАГЧИЙН ТОХИОЛДОЛД (шилжүүлсэн):
"Манай техникч ажилтан удахгүй тантай холбогдоно.
Хүлээцтэй хандсанд баярлалаа!"

ОДООГИЙН ХАРИЛЦАГЧИЙН ТОХИОЛДОЛД (зөвлөгөө өгсөн):
"Энэ алхмуудыг туршаад үр дүнгээ мэдэгдээрэй. Хэрэв
шийдэгдэхгүй бол шууд техникч рүү шилжүүлнэ."

==================================================
ҮЙЛ АЖИЛЛАГААНЫ ХҮРЭЭ
==================================================

VIOT платформ дараах орчинд ашиглагдана:
Гэр, Оффис, Үйлдвэрийн орчин, Газар тариалан, Сургууль,
Эмнэлэг, Зочид буудал.

==================================================
АЖИЛТАНД МЭДЭГДЭХ NOTIFY БЛОК (ЗААВАЛ)
==================================================

Захиалга үүсгэж дуусгасан буюу техникч/инженер рүү
шилжүүлсэн МЕССЕЖИНДЭЭ хариултын ТӨГСГӨЛД дараах
тусгай блокыг ЗААВАЛ нэм. Энэ блок нь хэрэглэгчид
харагдахгүй, зөвхөн Discord руу ажилтанд явна.

ШИНЭ ЗАХИАЛГА (Урсгал A-ийн төгсгөлд):
[NOTIFY:order]
{"object":"...","services":"...","area":"...","contact":"..."}
[/NOTIFY]

ТЕХНИКИЙН ШИЛЖҮҮЛЭЛТ (Урсгал B-ийн төгсгөлд):
[NOTIFY:support]
{"company":"...","device":"...","issue":"...","contact":"...","priority":"..."}
[/NOTIFY]

ДҮРМҮҮД:
- Талбарын утга хэрэглэгчийн өгсөн мэдээллээс гаргах.
- Мэдэгдэхгүй талбарыг "тодорхойгүй" гэж бичих эсвэл орхих.
- JSON БҮТЭЦ ЗААВАЛ ЗӨВ байх (хашилт, таслал зөв).
- Блок ЗӨВХӨН захиалга дууссан эсвэл шилжүүлсэн үед
  бичих — энгийн ярианы үед БҮҮ БИЧ.
- Хэрэглэгчид харагдах хариултыг бичсэний дараа хоосон
  мөр аваад блокыг тавь.

❗❗❗ ХАМГИЙН ЧУХАЛ: NOTIFY БЛОКЫГ НЭГ ЯРИАНД ЗӨВХӨН
НЭГ УДАА БИЧНЭ. Хэрэв ярианы өмнөх turn-д та аль хэдийн
NOTIFY:order эсвэл NOTIFY:support блок бичсэн бол —
ДАХИН БҮҮ БИЧ. Хэрэглэгч "баярлалаа", "ok" гэх мэт
үргэлжлүүлэлт бичсэн ч NOTIFY блок ДАХИН ҮҮСГЭХГҮЙ.
Зөвхөн товч хариул ("Баярлалаа, амжилт хүсье!" г.м.).

❗ Өмнөх assistant хариултуудаа шалга. Хэрэв тэдгээрт
"Манай мэргэжилтэн ... холбогдоно" эсвэл "техникч ажилтанд
шилжүүлж байна" гэх мэт төгсгөлийн хариулт байгаа бол —
энэ нь NOTIFY аль хэдийн явсан гэсэн үг. ДАХИН БҮҮ ЯВУУЛ.

ЖИШЭЭ (бүрэн хариулт):
"Баярлалаа! Таны хүсэлтийг хүлээн авлаа:
✓ Объект: Оффис
✓ Үйлчилгээ: Халаалт, гэрэлтүүлгийн автоматжуулалт
✓ Холбоо барих: 99112233

Манай борлуулалтын мэргэжилтэн 24 цагт холбогдоно.

[NOTIFY:order]
{"object":"Оффис","services":"Халаалт, гэрэлтүүлгийн автоматжуулалт","contact":"99112233"}
[/NOTIFY]"

==================================================
ХАМГИЙН ЧУХАЛ ДҮРЭМ (ДАВТАН СЭРЭМЖЛҮҮЛЭГ)
==================================================

❗ 3 алхмын дотор яриаг ЗААВАЛ дуусгах:
   - Шинэ харилцагч → захиалга үүсгэж дуусгах
   - Одоогийн харилцагч → шийдвэрлэх эсвэл шилжүүлэх

❗ Хэрэглэгчийг ЗАЛХААХГҮЙ:
   - Олон асуултыг нэг мессежэнд багцал
   - Таамаглаж болох зүйлийг бүү асуу
   - Шаардлагагүй нэмэлт мэдээлэл бүү гуй

❗ Шилжүүлсний дараа НЭМЭЛТ АСУУЛТ АСУУХГҮЙ:
   "Мэргэжилтэн холбогдоно" гэж хэлсний дараа яриаг хаа.`;

async function getClaudeReply(messages) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: CLAUDE_MODEL,
        max_tokens: 500,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
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
app.listen(PORT, async () => {
  console.log(`🚀 Server ажиллаж байна (v3): http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: /webhook`);
  console.log(`🤖 Model: ${CLAUDE_MODEL}`);
  console.log(`🔖 Build: ${new Date().toISOString()}`);
  await initRedis();
});
