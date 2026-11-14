-- One successful user operation costs one request, including audio and tool calls.
UPDATE plans SET price_minor=v.price, initial_assist_requests=v.requests,
    ai_usage_multiplier=NULL,
    description='Monthly AI requests for creating and editing music.',
    description_ru='Запросы к ИИ для создания и редактирования музыки.',
    features=ARRAY['Text and audio share one request allowance', 'One month of access; renew manually'],
    features_ru=ARRAY['Текст и аудио расходуют общий лимит', 'Один месяц доступа, ручное продление']
FROM (VALUES ('plus',39900,500),('pro',89900,2500),('ultra',599000,5000)) AS v(id,price,requests)
WHERE plans.id=v.id;
UPDATE storefront SET ai_usage_policy='Один успешно выполненный запрос к помощнику списывает один запрос из лимита, в том числе с аудио. Внутренние обращения к моделям отдельно не считаются. Ошибки и отменённые запросы не списываются. Лимит выдаётся на оплаченный период; неиспользованный остаток не переносится. Продление — вручную, без автоматических списаний.';

ALTER TABLE subscriptions ADD COLUMN period_ends_at timestamptz;
-- The old total counted only text; retain audio as a subset of the combined total.
UPDATE subscriptions SET assist_requests_used=assist_requests_used+audio_requests_used;
-- Existing manually assigned paid accounts get one initial period. Free balances stay intact.
UPDATE subscriptions s SET assist_requests_remaining=p.initial_assist_requests,
    period_ends_at=now()+interval '1 month'
FROM plans p WHERE p.id=s.tier AND p.id IN ('plus','pro','ultra');

-- Server-side grant for a confirmed purchase. No public API exposes this function.
-- The payment handler must call it exactly once in its idempotent order transaction.
CREATE FUNCTION activate_subscription(p_user_id uuid, p_plan_id text, p_start timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE selected plans%ROWTYPE;
BEGIN
    SELECT * INTO STRICT selected FROM plans WHERE id=p_plan_id AND visible AND NOT is_default;
    IF selected.billing_period NOT IN ('month','year') OR selected.initial_assist_requests IS NULL OR p_start IS NULL THEN
        RAISE EXCEPTION 'Plan must have a period and request allowance';
    END IF;
    UPDATE subscriptions SET tier=selected.id,
        assist_requests_remaining=selected.initial_assist_requests,
        period_ends_at=((p_start AT TIME ZONE 'UTC') + CASE selected.billing_period
            WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END) AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Subscription does not exist'; END IF;
END;
$$;
