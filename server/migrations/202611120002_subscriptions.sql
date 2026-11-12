CREATE TABLE subscriptions (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'plus', 'pro', 'ultra')),
    assist_requests_remaining integer NOT NULL DEFAULT 10 CHECK (assist_requests_remaining >= 0)
);
-- Existing accounts receive the same one-time welcome allowance.
INSERT INTO subscriptions (user_id) SELECT id FROM users;

-- Keep registration compatible with an application rollback: older server images
-- also get a subscription when they insert a user after this migration has run.
CREATE FUNCTION initialize_user_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO subscriptions (user_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_subscription AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION initialize_user_subscription();
