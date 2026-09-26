import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
mode = sys.argv[2]
if mode == "schema":
    cols = [r[1] for r in c.execute("PRAGMA table_info(message)").fetchall()]
    if "group_action_type" not in cols:
        c.execute("ALTER TABLE message ADD COLUMN group_action_type INTEGER DEFAULT 0")
else:
    def ins(rowid, text, handle_id, item_type=0, group_action_type=0, cache_has_attachments=0,
            assoc_type=0, assoc_guid=None, attributed_body=None):
        c.execute(
            "INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me, item_type, "
            "group_action_type, cache_has_attachments, associated_message_type, associated_message_guid) "
            "VALUES (?, ?, ?, ?, ?, 800000000000000000, 0, ?, ?, ?, ?, ?)",
            (rowid, "SYS-GUID-%d" % rowid, text, attributed_body, handle_id, item_type, group_action_type,
             cache_has_attachments, assoc_type, assoc_guid))
        c.execute("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (7, ?, 800000000000000000)", (rowid,))

    # System rows: item_type != 0 (participant/name changes) are ignored
    ins(380, None, 0, item_type=1)
    ins(381, None, 0, item_type=2)
    # Group event via group_action_type is ignored
    ins(382, None, 0, group_action_type=1)
    # '<empty message>' rows from sender 'Unknown' (handle 0): no text, attributedBody, or attachments
    ins(383, None, 0)
    ins(384, "   ", 0)
    ins(385, "\ufffc", 0)
    # Attachment-only rows are real messages
    ins(386, None, 1, cache_has_attachments=1)
    ins(387, None, 1)
    c.execute("INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) "
              "VALUES (9387, 'ATT-9387', '~/x.jpg', 'image/jpeg', 'x.jpg', 10)")
    c.execute("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (387, 9387)")
    # attributedBody-only text is a real message
    body = b"streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+\x05Hello\x86"
    ins(388, None, 1, attributed_body=body)
    # Normal text message
    ins(389, "Real incoming text", 1)
    # Tapback stays a reaction
    ins(390, "Loved \u201cReal incoming text\u201d", 1, assoc_type=2000, assoc_guid="p:0/SYS-GUID-389")
conn.commit()
conn.close()
