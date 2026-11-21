-- Keep historical test orders and their identity sequence; new orders can be live.
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_is_test_check;
