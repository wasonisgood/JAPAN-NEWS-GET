const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MAX_KEEP_DAYS = 7;

const headers = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "accept-language": "ja,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36"
};

function cleanText(text) {
  return text
    ?.replace(/[\u{1F600}-\u{1F64F}]/gu, "") // emoji
    ?.replace(/[\u{1F300}-\u{1F5FF}]/gu, "") // symbols
    ?.replace(/[\u{1F680}-\u{1F6FF}]/gu, "") // transport
    ?.replace(/<[^>]*>/g, "")                // HTML tags
    ?.replace(/&[^;]+;/g, "")                // HTML entities
    ?.replace(/[\r\n\t]/g, " ")              // control chars
    ?.trim();
}

// 批次翻譯函式
async function batchTranslateText(texts, targetLang) {
  if (!targetLang || targetLang === "ja") return texts;
  try {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey) return texts;
    const res = await axios.post(
      `https://translation.googleapis.com/language/translate/v2`,
      {},
      {
        params: {
          q: texts,
          target: targetLang,
          format: "text",
          key: apiKey,
        },
      }
    );
    return res.data.data.translations.map(t => t.translatedText);
  } catch (e) {
    console.warn("⚠️ 批次翻譯失敗：", e.message);
    return texts;
  }
}

// 語言代碼正規化
function normalizeLang(lang) {
  if (!lang) return "ja";
  const map = {
    "zh-tw": "zh-TW",
    "zh-cn": "zh-CN",
    "en": "en",
    "ja": "ja",
    // 你可依需求擴充
  };
  return map[lang.toLowerCase()] || lang;
}

exports.handler = async function (event) {
  const JST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const query = event.queryStringParameters || {};
  const date = query.date || JST.toISOString().slice(0, 10).replace(/-/g, '');
  const lang = query.lang || "ja";
  const googleLang = normalizeLang(lang);

  const baseUrl = `https://news.yahoo.co.jp/topics/top-picks?date=${date}`;
  const allItems = [];

  console.log("🕐 處理日期：", date);

  // 1️⃣ 查 Supabase 快取（先查有 lang 欄位的資料）
  let cached = null;
  try {
    const { data } = await supabase
      .from("rss_cache")
      .select("content,lang")
      .eq("date", date)
      .eq("lang", googleLang) // 修正：查詢時用 googleLang
      .maybeSingle();
    cached = data;
    // 兼容舊資料：如果 googleLang=ja 且沒查到，查找沒有 lang 欄位的快取
    if (!cached && googleLang === "ja") {
      const { data: oldData } = await supabase
        .from("rss_cache")
        .select("content")
        .eq("date", date)
        .is("lang", null)
        .maybeSingle();
      cached = oldData;
    }
    if (cached?.content) {
      console.log("📦 使用 Supabase 快取");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
        body: cached.content,
      };
    }
  } catch (e) {
    console.error("❗ Supabase 快取查詢錯誤：", e.message);
  }

  // 2️⃣ 開始即時抓取
  try {
    let page = 1;
    while (true) {
      const url = `${baseUrl}&page=${page}`;
      console.log(`🔗 正在抓取第 ${page} 頁: ${url}`);

      let res;
      try {
        res = await axios.get(url, { headers });
        console.log(`✅ 回應成功（狀態碼 ${res.status}）`);
      } catch (axiosErr) {
        const status = axiosErr.response?.status;
        if (status === 404) {
          console.log(`✅ 第 ${page} 頁回傳 404，抓取結束`);
          break; // ⛔ 不要 return 500，這是正常結束
        } else {
          console.error(`❌ axios.get 錯誤（HTTP ${status || 'unknown'}）`);
          return {
            statusCode: 500,
            body: `Yahoo 抓取失敗: ${axiosErr.message}`,
          };
        }
      }


      const $ = cheerio.load(res.data);

      const scriptTag = $("script").filter((i, el) => {
        const content = $(el).html();
        return content && content.includes("__PRELOADED_STATE__");
      }).first();

      if (!scriptTag.length) {
        console.warn(`⚠️ 找不到 __PRELOADED_STATE__（第 ${page} 頁）`);
        break;
      }

      let jsonText, json;
      try {
        jsonText = scriptTag.html().split("__PRELOADED_STATE__ = ")[1].split(";")[0];
        json = JSON.parse(jsonText);
      } catch (parseErr) {
        console.error("❌ JSON 解析錯誤：", parseErr.message);
        return {
          statusCode: 500,
          body: `JSON 解析失敗：${parseErr.message}`,
        };
      }

      const list = json.topicsList?.list ?? [];
      if (list.length === 0) {
        console.log("📭 該頁無資料，結束抓取");
        break;
      }

      console.log(`📄 第 ${page} 頁共抓到 ${list.length} 篇`);
      for (const item of list) {
        allItems.push({
          title: item.title,
          description: item.title,
          url: item.articleUrl,
          date: item.publishedTime,
        });
      }

      page++;
    }

    if (allItems.length === 0) {
      console.log("📭 全部頁面皆無內容");
      return {
        statusCode: 404,
        body: `沒有找到任何 Yahoo 新聞資料（${date}）`,
      };
    }

    const feed = new RSS({
      title: `Yahoo Japan トップニュース (${date})`,
      description: "Yahoo Japan 今日の話題",
      feed_url: `http://localhost:8888/rss?date=${date}&lang=${lang}`,
      site_url: "https://news.yahoo.co.jp/topics/top-picks",
      language: lang,
      pubDate: new Date(),
    });

    // 依語言翻譯標題與描述（批次）
    let titles = allItems.map(item => cleanText(item.title));
    let descriptions = allItems.map(item => cleanText(item.description));
    let translated = false;

    if (googleLang !== "ja") {
      const newTitles = await batchTranslateText(titles, googleLang);
      const newDescriptions = await batchTranslateText(descriptions, googleLang);
      // 檢查是否真的有翻譯
      if (JSON.stringify(newTitles) !== JSON.stringify(titles) || JSON.stringify(newDescriptions) !== JSON.stringify(descriptions)) {
        titles = newTitles;
        descriptions = newDescriptions;
        translated = true;
      }
    }
    allItems.forEach((item, idx) => {
      feed.item({
        title: titles[idx],
        description: descriptions[idx],
        url: item.url,
        date: item.date,
      });
    });

    const xml = feed.xml({ indent: true });

    // 3️⃣ 儲存到 Supabase 快取（僅翻譯有變化時才寫入）
    try {
      if (googleLang === "ja" || translated) {
        await supabase.from("rss_cache").upsert({
          date,
          lang: googleLang,
          content: xml,
          updated_at: new Date().toISOString(),
        });
        console.log("✅ 成功寫入 Supabase 快取");
      } else {
        console.warn("⚠️ 翻譯內容與原文相同，不寫入快取");
      }
    } catch (saveErr) {
      console.warn("⚠️ 快取儲存失敗：", saveErr.message);
    }

    // 4️⃣ 清除舊快取
    try {
      await supabase.rpc("delete_old_cache", { days_threshold: MAX_KEEP_DAYS });
      console.log("🧹 舊快取清理成功");
    } catch (cleanErr) {
      console.warn("⚠️ 舊快取清理失敗：", cleanErr.message);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body: xml,
    };
  } catch (err) {
    console.error("🐞 未知錯誤：", err.message);
    return {
      statusCode: 500,
      body: `錯誤: ${err.message}`,
    };
  }
};
