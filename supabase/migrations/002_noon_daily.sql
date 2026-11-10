-- Apply after 001_store.sql. Adds noon daily slot and raises limits to 5 product + 3 daily.
-- Replaces RPC only; existing rows, sequences, RLS, quotas and access grants are preserved.
BEGIN;
CREATE OR REPLACE FUNCTION public.kurashi_store_v1(action text, args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE
  result jsonb; p jsonb; slot_data jsonb; image jsonb;
  sns_value text; slot_id text; state_value text;
  moment timestamptz; start_day timestamptz; end_day timestamptz;
  row_count integer; count_total integer; count_kind integer;
  field_data jsonb; product_number bigint; config jsonb; month_value text; day_value text;
  amount numeric; committed numeric; category_used numeric; category_cap numeric;
  token_count integer; calls_today integer; tokens_today integer; mode text;
BEGIN
  IF action='health' THEN RETURN jsonb_build_object('schemaVersion',1,'scheduleVersion',2,'maxDailyPosts',8,'databaseTime',clock_timestamp()); END IF;
  -- Serialize all quota/slot reservation operations. This lock lasts only for this RPC transaction.
  IF action IN ('claim','reserve','settle','recordBill','setting','updatePost','saveProduct') THEN
    PERFORM pg_advisory_xact_lock(7193061701);
  END IF;
  IF action='saveProduct' THEN
    p:=args->'product';
    IF coalesce(p->>'id','')='' OR coalesce(p->>'canonical','')='' THEN RAISE EXCEPTION 'invalid_product'; END IF;
    INSERT INTO public.kurashi_products(id,canonical,data,updated_at)
      VALUES(p->>'id',p->>'canonical',p,(args->>'now')::timestamptz)
      ON CONFLICT(id) DO UPDATE SET canonical=excluded.canonical,data=excluded.data,updated_at=excluded.updated_at;
    SELECT data||jsonb_build_object('number',number) INTO result FROM public.kurashi_products WHERE id=p->>'id';
    RETURN result;
  ELSIF action='product' THEN
    SELECT data||jsonb_build_object('number',number) INTO result FROM public.kurashi_products WHERE id=args->>'id'; RETURN result;
  ELSIF action='products' THEN
    SELECT coalesce(jsonb_agg(data||jsonb_build_object('number',number) ORDER BY number DESC),'[]') INTO result FROM public.kurashi_products; RETURN result;
  ELSIF action='saveImage' THEN
    image:=args->'image';
    IF NOT EXISTS(SELECT 1 FROM public.kurashi_products WHERE id=image->>'productId') AND image->>'original' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'unknown_product'; END IF;
    IF coalesce(image->>'hash','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_image_hash'; END IF;
    INSERT INTO public.kurashi_images VALUES(image->>'id',image->>'productId',image->>'hash',image)
      ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,hash=excluded.hash,data=excluded.data;
    RETURN 'true';
  ELSIF action='images' THEN
    SELECT coalesce(jsonb_agg(data ORDER BY id),'[]') INTO result FROM public.kurashi_images WHERE product_id=args->>'id'; RETURN result;
  ELSIF action='cached' THEN
    SELECT data INTO result FROM public.kurashi_cache WHERE key=args->>'key' AND expires_at>(args->>'now')::timestamptz; RETURN result;
  ELSIF action='cache' THEN
    INSERT INTO public.kurashi_cache VALUES(args->>'key',args->'value',(args->>'expiresAt')::timestamptz)
      ON CONFLICT(key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at; RETURN 'true';
  ELSIF action='setting' THEN
    IF args ? 'value' THEN INSERT INTO public.kurashi_settings VALUES(args->>'key',args->'value')
      ON CONFLICT(key) DO UPDATE SET data=excluded.data; END IF;
    SELECT data INTO result FROM public.kurashi_settings WHERE key=args->>'key'; RETURN result;
  ELSIF action='post' THEN
    SELECT to_jsonb(t) INTO result FROM public.kurashi_posts t WHERE slot=args->>'slot' AND sns=args->>'sns'; RETURN result;
  ELSIF action='recentlyUsed' THEN
    RETURN to_jsonb(EXISTS(SELECT 1 FROM public.kurashi_posts WHERE canonical=args->>'canonical' AND slot<>args->>'exceptSlot'
      AND started_at>=(args->>'now')::timestamptz-make_interval(days=>(args->>'days')::integer)
      AND state IN ('preparing','prepared','sending','unknown','published')));
  ELSIF action='history' THEN
    SELECT coalesce(jsonb_agg(text ORDER BY started_at),'[]') INTO result FROM public.kurashi_posts
      WHERE sns=args->>'sns' AND started_at>=(args->>'since')::timestamptz AND text IS NOT NULL
        AND (NOT args ? 'kind' OR kind=args->>'kind') AND (NOT args ? 'exceptSlot' OR slot<>args->>'exceptSlot'); RETURN result;
  ELSIF action='claim' THEN
    slot_data:=args->'slot'; sns_value:=args->>'sns'; slot_id:=slot_data->>'id'; p:=args->'product'; config:=args->'config';
    moment:=(args->>'now')::timestamptz;
    IF coalesce((config->>'dailyPostLimit')::integer,0) NOT BETWEEN 1 AND 8 OR coalesce((config->>'duplicateDays')::integer,0)<30 THEN RAISE EXCEPTION 'invalid_store_config'; END IF;
    IF sns_value NOT IN ('threads','instagram') OR slot_data->>'kind' NOT IN ('product','daily') THEN RAISE EXCEPTION 'invalid_slot'; END IF;
    IF slot_id IS NULL OR slot_id<>to_char((slot_data->>'scheduledAt')::timestamptz AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD/HH24:MI')
      OR substring(slot_id,12) NOT IN ('07:00','08:10','10:30','12:00','12:20','16:00','17:40','19:00')
      OR (slot_data->>'kind'='daily') IS DISTINCT FROM (substring(slot_id,12) IN ('10:30','12:00','16:00')) THEN RAISE EXCEPTION 'invalid_slot'; END IF;
    IF EXISTS(SELECT 1 FROM public.kurashi_posts WHERE slot=slot_id AND sns=sns_value) THEN RETURN 'false'; END IF;
    IF p IS NOT NULL AND p<>'null' AND EXISTS(SELECT 1 FROM public.kurashi_posts WHERE canonical=p->>'canonical' AND slot<>slot_id
      AND started_at>=moment-make_interval(days=>(config->>'duplicateDays')::integer)
      AND state IN ('preparing','prepared','sending','unknown','published')) THEN RAISE EXCEPTION 'duplicate_product'; END IF;
    start_day:=(substring(slot_id,1,10)||'T00:00:00+09:00')::timestamptz; end_day:=start_day+interval '1 day';
    SELECT count(*),count(*) FILTER(WHERE kind=slot_data->>'kind') INTO count_total,count_kind FROM public.kurashi_posts
      WHERE sns=sns_value AND scheduled_at>=start_day AND scheduled_at<end_day AND state IN ('preparing','prepared','sending','unknown','published','dry_run');
    IF count_total>=(config->>'dailyPostLimit')::integer THEN RAISE EXCEPTION 'daily_post_limit'; END IF;
    IF count_kind>=(CASE WHEN slot_data->>'kind'='product' THEN 5 ELSE 3 END) THEN RAISE EXCEPTION 'daily_kind_limit'; END IF;
    INSERT INTO public.kurashi_posts(slot,sns,state,kind,canonical,product_id,scheduled_at,started_at)
      VALUES(slot_id,sns_value,'preparing',slot_data->>'kind',p->>'canonical',p->>'id',(slot_data->>'scheduledAt')::timestamptz,moment);
    RETURN 'true';
  ELSIF action='updatePost' THEN
    field_data:=coalesce(args->'fields','{}'); state_value:=args->>'state';
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(field_data) k WHERE k NOT IN ('text','container_id','remote_id','published_at','reason')) THEN RAISE EXCEPTION 'invalid_post_update'; END IF;
    UPDATE public.kurashi_posts SET state=state_value,
      text=CASE WHEN field_data ? 'text' THEN field_data->>'text' ELSE text END,
      container_id=CASE WHEN field_data ? 'container_id' THEN field_data->>'container_id' ELSE container_id END,
      remote_id=CASE WHEN field_data ? 'remote_id' THEN field_data->>'remote_id' ELSE remote_id END,
      published_at=CASE WHEN field_data ? 'published_at' THEN (field_data->>'published_at')::timestamptz ELSE published_at END,
      reason=CASE WHEN field_data ? 'reason' THEN field_data->>'reason' ELSE reason END
      WHERE slot=args->>'slot' AND sns=args->>'sns';
    GET DIAGNOSTICS row_count=ROW_COUNT; IF row_count<>1 THEN RAISE EXCEPTION 'unknown_post'; END IF; RETURN 'true';
  ELSIF action='log' THEN
    IF coalesce(args->>'code','') !~ '^[a-z0-9_]{1,80}$' THEN RAISE EXCEPTION 'invalid_log_code'; END IF;
    INSERT INTO public.kurashi_logs(at,code) VALUES((args->>'now')::timestamptz,args->>'code'); RETURN 'true';
  ELSIF action='cleanup' THEN
    moment:=(args->>'now')::timestamptz;
    DELETE FROM public.kurashi_logs WHERE at<moment-make_interval(days=>(args->>'days')::integer);
    DELETE FROM public.kurashi_cache WHERE expires_at<moment;
    UPDATE public.kurashi_events SET data='{}',author='' WHERE detected_at<moment-make_interval(days=>(args->>'days')::integer) AND state IN ('sent','excluded','dry_run'); RETURN 'true';
  ELSIF action='totals' THEN
    SELECT jsonb_build_object('committed',coalesce(sum(greatest(CASE WHEN state='reserved' THEN reserved ELSE estimated END,coalesce(actual_billed,0))),0),
      'estimated',coalesce(sum(estimated),0),'actualBilled',sum(actual_billed)) INTO result FROM public.kurashi_usage WHERE month=args->>'month'; RETURN result;
  ELSIF action='reserve' THEN
    config:=args->'config'; p:=args->'request'; moment:=(args->>'now')::timestamptz;
    IF coalesce((config->>'monthlyBudgetYen')::numeric,0)<=0 OR coalesce((config->>'textBudgetYen')::numeric,0)<=0
      OR coalesce((config->>'visionBudgetYen')::numeric,0)<=0 OR coalesce((config->>'maxAiCallsPerDay')::integer,0)<=0
      OR coalesce((config->>'maxAiTokensPerDay')::integer,0)<=0 THEN RAISE EXCEPTION 'invalid_store_config'; END IF;
    amount:=(p->>'maximumYen')::numeric; token_count:=coalesce((p->>'maximumTokens')::integer,0);
    IF amount IS NULL OR amount<=0 OR amount::text IN ('NaN','Infinity') OR token_count<0 THEN RAISE EXCEPTION 'invalid_reservation'; END IF;
    IF config->>'emergencyStop'='true' OR config->>'termsStop'='true' OR EXISTS(SELECT 1 FROM public.kurashi_settings WHERE key='emergencyStop' AND data='true') THEN RAISE EXCEPTION 'all_stopped'; END IF;
    month_value:=to_char(moment AT TIME ZONE 'Asia/Tokyo','YYYY-MM'); day_value:=to_char(moment AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD');
    SELECT coalesce(sum(greatest(CASE WHEN state='reserved' THEN reserved ELSE estimated END,coalesce(actual_billed,0))),0) INTO committed FROM public.kurashi_usage WHERE month=month_value;
    IF committed/(config->>'monthlyBudgetYen')::numeric>=0.95 OR (p->>'category'='vision' AND committed/(config->>'monthlyBudgetYen')::numeric>=0.7)
      OR (committed/(config->>'monthlyBudgetYen')::numeric>=0.85 AND coalesce(p->>'essential','false')<>'true') THEN RAISE EXCEPTION 'budget_throttled'; END IF;
    IF committed+amount>(config->>'monthlyBudgetYen')::numeric THEN RAISE EXCEPTION 'monthly_budget'; END IF;
    SELECT coalesce(sum(greatest(CASE WHEN state='reserved' THEN reserved ELSE estimated END,coalesce(actual_billed,0))),0) INTO category_used FROM public.kurashi_usage WHERE month=month_value AND category=p->>'category';
    category_cap:=CASE p->>'category' WHEN 'vision' THEN (config->>'visionBudgetYen')::numeric WHEN 'text' THEN (config->>'textBudgetYen')::numeric ELSE (config->>'monthlyBudgetYen')::numeric END;
    IF category_used+amount>category_cap THEN RAISE EXCEPTION 'category_budget'; END IF;
    SELECT count(*),coalesce(sum(tokens),0) INTO calls_today,tokens_today FROM public.kurashi_usage WHERE day=day_value;
    IF calls_today>=(config->>'maxAiCallsPerDay')::integer OR tokens_today+token_count>(config->>'maxAiTokensPerDay')::integer THEN RAISE EXCEPTION 'daily_ai_limit'; END IF;
    INSERT INTO public.kurashi_usage(id,month,day,category,service,state,reserved,tokens,created_at)
      VALUES(args->>'id',month_value,day_value,p->>'category',p->>'service','reserved',amount,token_count,moment); RETURN to_jsonb(args->>'id');
  ELSIF action='settle' THEN
    IF (args->>'estimatedYen')::numeric<0 OR (args->>'tokens')::integer<0 THEN RAISE EXCEPTION 'invalid_settlement'; END IF;
    UPDATE public.kurashi_usage SET state='settled',estimated=(args->>'estimatedYen')::numeric,tokens=(args->>'tokens')::integer WHERE id=args->>'id' AND state='reserved';
    GET DIAGNOSTICS row_count=ROW_COUNT; IF row_count<>1 THEN RAISE EXCEPTION 'invalid_settlement'; END IF; RETURN 'true';
  ELSIF action='recordBill' THEN
    IF (args->>'actualYen')::numeric<0 THEN RAISE EXCEPTION 'invalid_bill'; END IF;
    UPDATE public.kurashi_usage SET actual_billed=(args->>'actualYen')::numeric WHERE id=args->>'id';
    GET DIAGNOSTICS row_count=ROW_COUNT; IF row_count<>1 THEN RAISE EXCEPTION 'unknown_reservation'; END IF; RETURN 'true';
  ELSIF action='report' THEN
    moment:=(args->>'now')::timestamptz;
    start_day:=date_trunc('month',moment AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo';
    RETURN jsonb_build_object('month',to_char(moment AT TIME ZONE 'Asia/Tokyo','YYYY-MM'),
      'emergencyStop',coalesce((SELECT data FROM public.kurashi_settings WHERE key='emergencyStop'),'false'),
      'posts',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT sns,state,count(*) count FROM public.kurashi_posts WHERE started_at>=start_day GROUP BY sns,state) t),
      'replies',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT sns,state,count(*) count FROM public.kurashi_events WHERE detected_at>=start_day GROUP BY sns,state) t),
      'errors',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT code,count(*) count FROM public.kurashi_logs WHERE at>=start_day GROUP BY code) t),
      'aiUsage',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT service,category,count(*) calls,sum(tokens) tokens FROM public.kurashi_usage WHERE month=to_char(moment AT TIME ZONE 'Asia/Tokyo','YYYY-MM') GROUP BY service,category) t),
      'rights',jsonb_build_object('registered',(SELECT count(*) FROM public.kurashi_images),'expired',(SELECT count(*) FROM public.kurashi_images WHERE (data->>'expiresAt')::timestamptz<=moment)));
  ELSIF action='siteData' THEN
    RETURN jsonb_build_object('products',(SELECT coalesce(jsonb_agg(data||jsonb_build_object('number',number) ORDER BY number DESC),'[]') FROM public.kurashi_products),
      'images',(SELECT coalesce(jsonb_agg(data),'[]') FROM public.kurashi_images));
  ELSIF action='export' THEN
    -- One RPC runs in one snapshot; contains private rights/PII. Never publish this result.
    RETURN jsonb_build_object('schemaVersion',1,'exportedAt',clock_timestamp(),
      'sequences',jsonb_build_object('products',(SELECT last_value FROM public.kurashi_products_number_seq),'logs',(SELECT last_value FROM public.kurashi_logs_id_seq)),
      'tables',jsonb_build_object(
      'products',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_products t),
      'images',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_images t),
      'cache',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_cache t),
      'posts',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_posts t),
      'usage',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_usage t),
      'events',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_events t),
      'opt_outs',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_opt_outs t),
      'logs',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_logs t),
      'settings',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.kurashi_settings t)));
  ELSIF action='restore' THEN
    PERFORM pg_advisory_xact_lock(7193061701);
    LOCK TABLE public.kurashi_products,public.kurashi_images,public.kurashi_cache,public.kurashi_posts,
      public.kurashi_usage,public.kurashi_events,public.kurashi_opt_outs,public.kurashi_logs,public.kurashi_settings IN ACCESS EXCLUSIVE MODE;
    p:=args->'snapshot';
    IF p->>'schemaVersion' IS DISTINCT FROM '1' OR args->>'confirmEmptyDatabase' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'invalid_restore'; END IF;
    IF EXISTS(SELECT 1 FROM public.kurashi_products UNION ALL SELECT 1 FROM public.kurashi_images UNION ALL SELECT 1 FROM public.kurashi_cache
      UNION ALL SELECT 1 FROM public.kurashi_posts UNION ALL SELECT 1 FROM public.kurashi_usage UNION ALL SELECT 1 FROM public.kurashi_events
      UNION ALL SELECT 1 FROM public.kurashi_opt_outs UNION ALL SELECT 1 FROM public.kurashi_logs UNION ALL SELECT 1 FROM public.kurashi_settings) THEN RAISE EXCEPTION 'restore_target_not_empty'; END IF;
    IF NOT (p->'tables' ?& ARRAY['products','images','cache','posts','usage','events','opt_outs','logs','settings']) THEN RAISE EXCEPTION 'invalid_restore'; END IF;
    INSERT INTO public.kurashi_products OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_products,p->'tables'->'products');
    INSERT INTO public.kurashi_images SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_images,p->'tables'->'images');
    INSERT INTO public.kurashi_cache SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_cache,p->'tables'->'cache');
    INSERT INTO public.kurashi_posts SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_posts,p->'tables'->'posts');
    INSERT INTO public.kurashi_usage SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_usage,p->'tables'->'usage');
    INSERT INTO public.kurashi_events SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_events,p->'tables'->'events');
    INSERT INTO public.kurashi_opt_outs SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_opt_outs,p->'tables'->'opt_outs');
    INSERT INTO public.kurashi_logs OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_logs,p->'tables'->'logs');
    INSERT INTO public.kurashi_settings SELECT * FROM jsonb_populate_recordset(NULL::public.kurashi_settings,p->'tables'->'settings');
    PERFORM setval(pg_get_serial_sequence('public.kurashi_products','number'),greatest(coalesce(max(number),0),coalesce((p->'sequences'->>'products')::bigint,0),1),max(number) IS NOT NULL OR (p->'sequences'->>'products') IS NOT NULL) FROM public.kurashi_products;
    PERFORM setval(pg_get_serial_sequence('public.kurashi_logs','id'),greatest(coalesce(max(id),0),coalesce((p->'sequences'->>'logs')::bigint,0),1),max(id) IS NOT NULL OR (p->'sequences'->>'logs') IS NOT NULL) FROM public.kurashi_logs;
    RETURN 'true';
  END IF;
  RAISE EXCEPTION 'unsupported_store_action';
END $$;
REVOKE ALL ON FUNCTION public.kurashi_store_v1(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kurashi_store_v1(text,jsonb) TO service_role;
COMMIT;
