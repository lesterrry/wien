CREATE TABLE plans (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]*$'),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    description text NOT NULL,
    features text[] NOT NULL DEFAULT '{}',
    price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 9007199254740991),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_minor_units smallint NOT NULL DEFAULT 2 CHECK (currency_minor_units BETWEEN 0 AND 4),
    billing_period text NOT NULL CHECK (billing_period IN ('none', 'month', 'year')),
    -- NULL means unlimited; a number is a one-time allowance, not a monthly quota.
    initial_assist_requests integer CHECK (initial_assist_requests >= 0),
    audio_enabled boolean NOT NULL DEFAULT false,
    is_default boolean NOT NULL DEFAULT false,
    visible boolean NOT NULL DEFAULT true,
    display_order integer NOT NULL DEFAULT 0,
    CHECK (NOT is_default OR (price_minor = 0 AND billing_period = 'none')),
    CHECK (billing_period <> 'none' OR price_minor = 0)
);
CREATE UNIQUE INDEX plans_one_default ON plans (is_default) WHERE is_default;

INSERT INTO plans (id, name, description, features, price_minor, currency, billing_period,
                   initial_assist_requests, audio_enabled, is_default, display_order)
VALUES
    ('free', 'Free', 'Try Assist with a one-time welcome allowance.',
     ARRAY['10 text Assist requests', 'Audio attachments not included'],
     0, 'RUB', 'none', 10, false, true, 0),
    ('plus', 'PLUS', 'Unlimited Assist with text and audio attachments.',
     ARRAY['Unlimited text Assist requests', 'Audio attachments included'],
     19900, 'RUB', 'month', NULL, true, false, 1),
    ('pro', 'PRO', 'Unlimited Assist with text and audio attachments.',
     ARRAY['Unlimited text Assist requests', 'Audio attachments included'],
     69900, 'RUB', 'month', NULL, true, false, 2),
    ('ultra', 'ULTRA', 'Unlimited Assist with text and audio attachments.',
     ARRAY['Unlimited text Assist requests', 'Audio attachments included'],
     399000, 'RUB', 'month', NULL, true, false, 3);

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_tier_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_fkey FOREIGN KEY (tier) REFERENCES plans(id);
ALTER TABLE subscriptions ALTER COLUMN tier DROP DEFAULT;
ALTER TABLE subscriptions ALTER COLUMN assist_requests_remaining DROP DEFAULT;

CREATE OR REPLACE FUNCTION initialize_user_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    default_plan plans%ROWTYPE;
BEGIN
    SELECT * INTO STRICT default_plan FROM plans WHERE is_default;
    INSERT INTO subscriptions (user_id, tier, assist_requests_remaining)
        VALUES (NEW.id, default_plan.id, COALESCE(default_plan.initial_assist_requests, 0));
    RETURN NEW;
END;
$$;
