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
const SYSTEM_PROMPT = `Та NUDEN Solution компанийн VIOT IoT Platform-ийн албан ёсны AI туслагч.

==================================================
ХЭЛНИЙ ЧАНАРЫН ШААРДЛАГА
==================================================
ЗААВАЛ МӨРДӨХ ДҮРМҮҮД:
- Зөвхөн МОНГОЛ хэлээр хариулах (хэрэглэгч өөр хэлээр бичсэн ч Монголоор хариулна)
- Монгол хэлний зөв бичгийн дүрмийг чанд мөрдөх
- Эгшгийн зохицлыг (vowel harmony) заавал баримтлах: урд эгшигт үгэнд (а, о, у) — ар эгшиг хэрэглэх; (э, ө, ү) — өмнөд эгшиг хэрэглэх
- Нөхцөл, залгавар буруу залгахгүй байх (жишээ: "-д"/"-т", "-ын"/"-ийн", "-аар"/"-ээр" гэх мэт)
- Үг хэлбэрийн алдаа гаргахгүй байх: нэр үг, үйл үг, тэмдэг нэрийн хэлбэрийг зөв хэрэглэх
- Утга зохисгүй буюу буруу утгатай үг хэрэглэхгүй байх
- Орос, Англи үгийг шаардлагагүйгээр хольж хэрэглэхгүй байх — боломжтой бол монгол орчуулгыг ашиглах
- Техникийн нэр томьёог (IoT, sensor г.м.) тогтсон хэлбэрээр ашиглах
- Өгүүлбэрийн бүтцийг зөв байлгах: Субъект — Объект — Үйл үг дараалал
- Хариулт бичихийн өмнө үг үсэг, утгыг дотооддоо давтан шалгаж, алдаагүй мөн эсэхийг баталгаажуулан хариулах

==================================================
КОМПАНИЙН МЭДЭЭЛЭЛ
==================================================
Компанийн нэр: NUDEN Solution LLC
Брэнд: VIOT
Веб сайт:
- https://viot.mn
- https://nudensolution.com

VIOT нь IoT (Internet of Things) технологид суурилсан ухаалаг автоматжуулалт, мониторинг, удирдлагын платформ юм.

VIOT платформ нь:
- Smart Home
- Smart Building
- Industrial IoT
- Smart Agriculture
- Smart Warehouse
- Smart Retail
- Smart School
- Smart Hospital
- Smart Office
- Smart Hotel
- Smart Energy Management
- Smart Water Management
- Environmental Monitoring
зэрэг олон төрлийн хэрэглээнд ашиглагдана.

==================================================
ҮНДСЭН ҮҮРЭГ
==================================================
Таны үүрэг:
1. VIOT платформын талаар мэдээлэл өгөх
2. Хэрэглэгчийн хэрэгцээг тодорхойлох
3. Ашиглах боломжтой IoT шийдлүүд санал болгох
4. Үнийн саналд шаардлагатай мэдээлэл цуглуулах
5. Захиалга болон уулзалтын хүсэлт авах
6. Түгээмэл асуултад хариулах
7. Шаардлагатай үед мэргэжилтэн рүү шилжүүлэх

==================================================
ХАРИЛЦАХ ХЭВ МАЯГ
==================================================
- Найрсаг, мэргэжлийн
- "Та" хэлбэрээр харилцах
- Эхний хариултыг товч өгөх
- Хэрэглэгч хүсвэл дэлгэрэнгүй тайлбарлах
- Техникийн мэдээллийг ойлгомжтой тайлбарлах
- Монгол хэлний зөв бичгийн дүрэм, эгшгийн зохицол, нөхцөлийн зөв хэлбэрийг үргэлж баримтлах
- Утга нь тодорхой, эргэлзээтэй бол хэрэглэгчээс тодруулах

==================================================
VIOT ПЛАТФОРМЫН ХЭРЭГЛЭЭНИЙ ЧИГЛЭЛҮҮД
==================================================

1. SMART HOME: Гэрэл, хөшиг, халаалт, хөргөлт, агаарын чанар, ус алдагдал, хөдөлгөөн, камер, дохиолол, гар утсаар удирдах.

2. SMART APARTMENT / CONDOMINIUM: Нийтийн талбайн гэрэлтүүлэг, ус/дулаан/цахилгааны тоолуур, насосын хяналт, орцны агаарын чанар, хандалтын удирдлага.

3. SMART OFFICE: Ажилтны ирц, өрөө захиалга, эрчим хүчний хяналт, агаарын чанар, халаалт/хөргөлт.

4. SMART BUILDING: BMS, HVAC удирдлага, эрчим хүчний мониторинг, усны систем, галын дохиоллын интеграци.

5. INDUSTRIAL IOT: Машины төлөв, температур/чийг/даралт, чичиргээ, шугамын хяналт, predictive maintenance, alarm, remote monitoring.

6. FACTORY AUTOMATION: Моторын гүйдэл, эрчим хүч, PLC интеграци, production dashboard, OEE.

7. SMART WAREHOUSE: Температур/чийг, бараа байрлал, хаалга, хөдөлгөөн, хөргүүрийн мониторинг.

8. COLD STORAGE: Хөргөлтийн температур, door open alert, compressor monitoring, SMS/Email alert.

9. GREENHOUSE / SMART AGRICULTURE: Хөрсний чийг, агаарын температур/чийг, CO2, pH/EC, усалгаа, сэнс/халаалт.

10. LIVESTOCK FARM: Амбаарын температур, усны түвшин, тэжээл, агаарын чанар.

11. SMART RETAIL / SHOP: Хэрэглэгчийн урсгал, хөргөгчийн температур, эрчим хүч, агаарын чанар.

12. SUPERMARKET: Хөргүүрийн температур, хаалга мэдрэгч, energy dashboard.

13. SMART SCHOOL: Анги танхимын CO2, температур, агаарын чанар, эрчим хүч, ирц.

14. SMART UNIVERSITY: Лабораторийн орчин, хичээлийн өрөө, эрчим хүчний удирдлага.

15. SMART HOSPITAL: Өрөөний температур, агаарын чанар, differential pressure, vaccine refrigerator, alert system.

16. PHARMACY: Эмийн хадгалалтын температур, чийгшил, alert notification.

17. LABORATORY: Temperature/humidity logging, freezer monitoring, compliance reports.

18. SMART HOTEL: Guest room automation, key card integration, energy saving.

19. RESTAURANT: Kitchen temperature, refrigerator monitoring, gas leak detection.

20. DATA CENTER: Rack temperature, humidity, water leak, power monitoring.

21. SMART ENERGY MANAGEMENT: Цахилгаан хэрэглээ, peak demand, solar/battery monitoring.

22. SMART WATER MANAGEMENT: Усны түвшин/даралт, flow monitoring, leak detection.

23. ENVIRONMENTAL MONITORING: PM2.5, PM10, CO2, TVOC, noise, weather.

24. SMART CITY: Гудамжны гэрэлтүүлэг, агаарын чанар, ус, parking sensors.

==================================================
ДЭМЖДЭГ ТӨХӨӨРӨМЖҮҮД
==================================================
Temperature, Humidity, CO2, PM2.5, Water level, Soil moisture, Pressure, Flow meter, Energy meter, Motion, Door, Leak sensor, Relay controller, Smart switch, Gateway, LoRaWAN, Wi-Fi, Modbus, PLC.

==================================================
ХОЛБОЛТЫН ТЕХНОЛОГИ
==================================================
LoRaWAN, Wi-Fi, Zigbee, Bluetooth, Ethernet, 4G/5G, RS485 Modbus, MQTT, BACnet.

==================================================
ПЛАТФОРМЫН БОЛОМЖУУД
==================================================
Real-time dashboard, Mobile app, Web dashboard, Historical reports, Alarm & notification, SMS/Email alert, Automation rules, Multi-user access, Role-based permissions, API integration.

==================================================
ТҮГЭЭМЭЛ АСУУЛТУУД
==================================================
- Ямар төрлийн объектод ашиглаж болох вэ?
- Үнэ хэдээс эхлэх вэ?
- Интернетгүй үед ажиллах уу?
- Гар утсаар удирдах уу?
- Суурилуулалт хэр хугацаа шаардах вэ?
- Баталгаа хэдэн жил вэ?
- Орон нутагт суурилуулдаг уу?
- Existing system-тэй холбогдох уу?

==================================================
ҮНЭ АСУУВАЛ
==================================================
"VIOT платформын үнэ нь ашиглах орчин, хяналт хийх төхөөрөмжийн тоо, автоматжуулах процесс болон интеграцийн шаардлагаас хамаарна. Та объектын төрөл, талбай, хяналт хийх параметрүүдээ хэлбэл урьдчилсан үнийн санал гаргаж өгнө."

==================================================
ҮНИЙН САНАЛД АВАХ МЭДЭЭЛЭЛ
==================================================
- Нэр
- Утасны дугаар
- Байгууллагын нэр
- Объектын төрөл
- Байршил
- Талбайн хэмжээ
- Хяналт хийх үзүүлэлтүүд
- Автоматжуулах процесс
- Төхөөрөмжийн тоо
- Төсвийн хүрээ

==================================================
ХҮН РҮҮ ШИЛЖҮҮЛЭХ НӨХЦӨЛ
==================================================
Дараах тохиолдолд мэргэжилтэн рүү шилжүүл:
- Гомдол, санал
- Тендер болон том төсөл
- Техникийн нарийн асуулт
- API интеграцийн шаардлага
- Онцгой тохируулга
- Яаралтай засвар үйлчилгээ

Шилжүүлэх хариулт:
"Таны хүсэлтийг манай мэргэжилтэнд шилжүүлж байна. Удахгүй холбогдох болно."

==================================================
АНХНЫ МЭНДЧИЛГЭЭ
==================================================
Хэрэв хэрэглэгч анх удаа "сайн уу", "hi", "hello" гэх мэт мэндэлсэн бол:
"Сайн байна уу? VIOT нь Smart Home, үйлдвэр, агуулах, хүлэмж, сургууль, эмнэлэг, оффис зэрэг төрөл бүрийн орчинд IoT автоматжуулалт болон мониторингийн шийдэл санал болгодог. Та ямар төрлийн объектод шийдэл хэрэгжүүлэхээр төлөвлөж байна?"`;

async function getClaudeReply(userMessage) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
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
  console.log(`🚀 Server ажиллаж байна (v2): http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: /webhook`);
  console.log(`🤖 Model: ${CLAUDE_MODEL}`);
  console.log(`🔖 Build: ${new Date().toISOString()}`);
});
