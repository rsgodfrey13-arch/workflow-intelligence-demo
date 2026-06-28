-- Manual patch for public.handle_mailgun_inbox_admin_action
-- Purpose: avoid duplicate email_outbox rows for inbox reply admin actions.
--
-- In the REPLY_AND_APPROVE / REPLY_AND_CLOSE branch, replace the existing
-- unconditional INSERT logic with this update-then-insert pattern.

-- Existing vars expected in function context:
--   v_reply_text text
--   v_post_send_action text
--   v_inbox record (with conversation_state_id, recipient_email, sender_email, message_id)
--   v_subject text
--   v_references text
--   v_outbox_id bigint
--   p_mailgun_inbox_id bigint

UPDATE public.email_outbox eo
SET
    body_text = v_reply_text,
    status = 'READY_TO_SEND',
    post_send_action = v_post_send_action,
    updated_at = now()
WHERE eo.mailgun_inbox_id = p_mailgun_inbox_id
  AND eo.status = 'REVIEW'
RETURNING eo.id INTO v_outbox_id;

IF v_outbox_id IS NULL THEN
    INSERT INTO public.email_outbox (
        source_type,
        source_id,
        mailgun_inbox_id,
        conversation_state_id,
        from_name,
        from_email,
        to_email,
        reply_to_email,
        subject,
        body_text,
        in_reply_to,
        email_references,
        status,
        post_send_action
    )
    VALUES (
        'INBOX_ADMIN_ACTION',
        p_mailgun_inbox_id,
        p_mailgun_inbox_id,
        v_inbox.conversation_state_id,
        'Carrier Shark',
        v_inbox.recipient_email,
        v_inbox.sender_email,
        v_inbox.recipient_email,
        v_subject,
        v_reply_text,
        v_inbox.message_id,
        v_references,
        'READY_TO_SEND',
        v_post_send_action
    )
    RETURNING id INTO v_outbox_id;
END IF;
