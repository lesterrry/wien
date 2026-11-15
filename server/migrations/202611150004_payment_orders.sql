CREATE TABLE payment_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    merchant_login text NOT NULL,
    is_test boolean NOT NULL CHECK (is_test), -- live payments deliberately unsupported for now
    plan_id text NOT NULL REFERENCES plans(id),
    plan_name text NOT NULL,
    price_minor bigint NOT NULL CHECK (price_minor > 0 AND price_minor <= 9007199254740991),
    currency text NOT NULL CHECK (currency='RUB'),
    request_limit integer NOT NULL CHECK (request_limit > 0),
    audio_enabled boolean NOT NULL,
    document_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','paid','paid_review')),
    paid_at timestamptz,
    period_ends_at timestamptz,
    UNIQUE(user_id,request_id),
    CHECK ((status IN ('paid','paid_review')) = (paid_at IS NOT NULL)),
    CHECK ((status='paid') = (period_ends_at IS NOT NULL))
);
CREATE UNIQUE INDEX payment_orders_one_pending ON payment_orders(user_id) WHERE status='pending';
CREATE INDEX payment_orders_user_history ON payment_orders(user_id,created_at DESC);

-- Preserve the purchased allowance/audio access even if catalog rules change later.
ALTER TABLE subscriptions ADD COLUMN period_request_limit integer CHECK (period_request_limit >= 0),
    ADD COLUMN period_audio_enabled boolean,
    ADD COLUMN payment_order_id uuid UNIQUE REFERENCES payment_orders(id);

-- Existing manually activated periods retain their current policy after catalog edits too.
UPDATE subscriptions s SET period_request_limit=p.initial_assist_requests,
    period_audio_enabled=p.audio_enabled
FROM plans p WHERE p.id=s.tier AND s.period_ends_at IS NOT NULL;

CREATE OR REPLACE FUNCTION activate_subscription(p_user_id uuid, p_plan_id text, p_start timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE selected plans%ROWTYPE;
BEGIN
    SELECT * INTO STRICT selected FROM plans WHERE id=p_plan_id AND visible AND NOT is_default;
    IF selected.billing_period NOT IN ('month','year') OR selected.initial_assist_requests IS NULL OR p_start IS NULL THEN
        RAISE EXCEPTION 'Plan must have a period and request allowance';
    END IF;
    UPDATE subscriptions SET tier=selected.id,
        assist_requests_remaining=selected.initial_assist_requests,
        period_request_limit=selected.initial_assist_requests,
        period_audio_enabled=selected.audio_enabled, payment_order_id=NULL,
        period_ends_at=((p_start AT TIME ZONE 'UTC') + CASE selected.billing_period
            WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END) AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Subscription does not exist'; END IF;
END;
$$;
