SET search_path TO tr;
DROP TRIGGER IF EXISTS admission_log_append_only ON admission_log;
DROP TABLE IF EXISTS event_staff, admission_log, ticket_transfers, tickets, webhook_events, payments,
  order_items, orders, tracking_links, promo_codes, ticket_types, events, uploads;
