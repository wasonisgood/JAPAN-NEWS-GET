import requests
import json
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone

def get_today_japan_date():
    # 日本時間 UTC+9
    JST = timezone(timedelta(hours=9))
    return datetime.now(JST).strftime('%Y%m%d')

def fetch_page(date_str, page):
    url = f"https://news.yahoo.co.jp/topics/top-picks?date={date_str}&page={page}"
    headers = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*",
        "accept-language": "ja,en;q=0.9",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36"
    }
    response = requests.get(url, headers=headers)
    response.raise_for_status()  # 若是 404 就會進入錯誤處理
    return response.text

def parse_articles(html):
    soup = BeautifulSoup(html, 'html.parser')
    script_tag = soup.find("script", string=lambda s: s and "__PRELOADED_STATE__" in s)
    if not script_tag:
        return []

    try:
        json_text = script_tag.string.split("__PRELOADED_STATE__ = ")[-1].rstrip(";")
        state = json.loads(json_text)
        return state['topicsList']['list']
    except Exception as e:
        print("解析失敗：", e)
        return []

def main():
    date_str = get_today_japan_date()
    page = 1
    all_articles = []

    while True:
        print(f"抓取第 {page} 頁...")
        try:
            html = fetch_page(date_str, page)
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                print("已抓取完所有頁面，結束。")
                break
            else:
                raise e  # 若非 404，則拋出錯誤

        articles = parse_articles(html)
        if not articles:
            print("該頁無資料，結束。")
            break

        all_articles.extend(articles)
        page += 1

    output_filename = f'yahoo_news_{date_str}.json'
    with open(output_filename, 'w', encoding='utf-8') as f:
        json.dump(all_articles, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 共抓取 {len(all_articles)} 篇新聞，已儲存至 {output_filename}")

if __name__ == "__main__":
    main()
