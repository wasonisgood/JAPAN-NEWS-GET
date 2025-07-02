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


exports.handler = async function (event) {
  const JST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const query = event.queryStringParameters || {};
  const date = query.date || JST.toISOString().slice(0, 10).replace(/-/g, '');
  const baseUrl = `https://news.yahoo.co.jp/topics/top-picks?date=${date}`;
  const allItems = [];

  console.log("🕐 處理日期：", date);

  // 1️⃣ 查 Supabase 快取
  try {
    const { data: cached } = await supabase
      .from("rss_cache")
      .select("content")
      .eq("date", date)
      .maybeSingle();

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
      feed_url: `http://localhost:8888/rss?date=${date}`,
      site_url: "https://news.yahoo.co.jp/topics/top-picks",
      language: "ja",
      pubDate: new Date(),
    });

    allItems.forEach(item => {
 feed.item({
  title: cleanText(item.title),
  description: cleanText(item.description),
  url: item.url,
  date: item.date,
});
    });

    const xml = feed.xml({ indent: true });

    // 3️⃣ 儲存到 Supabase 快取
    try {
      await supabase.from("rss_cache").upsert({
        date,
        content: xml,
        updated_at: new Date().toISOString(),
      });
      console.log("✅ 成功寫入 Supabase 快取");
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
