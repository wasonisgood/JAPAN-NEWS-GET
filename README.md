-- 建立資料表
create table if not exists rss_cache (
  date text primary key,
  content text not null,
  updated_at timestamp with time zone default now()
);

-- 自動清除過期資料的函數
create or replace function delete_old_cache(days_threshold integer)
returns void as $$
begin
  delete from rss_cache
  where updated_at < now() - interval '1 day' * days_threshold;
end;
$$ language plpgsql;

-- 可選：建立索引
create index if not exists idx_rss_cache_updated on rss_cache(updated_at);
