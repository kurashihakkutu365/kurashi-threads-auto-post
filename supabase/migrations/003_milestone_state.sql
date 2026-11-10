-- Optional milestone queue, after 001 and 002. No new tables, no data deletion.
-- State is part of the existing settings backup/export. CAS prevents lost updates across runners.
BEGIN;
CREATE OR REPLACE FUNCTION public.kurashi_milestones_v1(action text,args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_revision bigint; expected_revision bigint; next_state jsonb;
BEGIN
  IF action='health' THEN RETURN jsonb_build_object('milestoneVersion',1); END IF;
  IF action<>'cas' THEN RAISE EXCEPTION 'unsupported_store_action'; END IF;
  expected_revision:=(args->>'expectedRevision')::bigint;next_state:=args->'state';
  IF expected_revision IS NULL OR expected_revision<0 OR jsonb_typeof(next_state) IS DISTINCT FROM 'object'
    OR octet_length(next_state::text)>32768 OR next_state->>'version' IS DISTINCT FROM '1'
    OR (next_state->>'revision')::bigint IS DISTINCT FROM expected_revision+1
    OR coalesce((next_state->>'count')::bigint,-1) NOT BETWEEN 0 AND 1000000000
    OR jsonb_typeof(next_state->'events') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'milestone_state_invalid'; END IF;
  IF jsonb_array_length(next_state->'events')>8 THEN RAISE EXCEPTION 'milestone_state_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(7193061701);
  SELECT coalesce((data->>'revision')::bigint,0) INTO current_revision FROM public.kurashi_settings WHERE key='rakuten_confirmed_milestones_v1';
  IF coalesce(current_revision,0)<>expected_revision THEN RETURN 'false'; END IF;
  INSERT INTO public.kurashi_settings(key,data) VALUES('rakuten_confirmed_milestones_v1',next_state)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data;
  RETURN 'true';
END $$;
REVOKE ALL ON FUNCTION public.kurashi_milestones_v1(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kurashi_milestones_v1(text,jsonb) TO service_role;
COMMIT;
