#!/usr/bin/env python3
"""Build a synthetic chat.db for read-side tests.

The fixture is shaped like macOS Messages' chat.db (only the columns this
server reads). It is not a byte-for-byte copy of a real database: payload_data
uses a minimal NSKeyedArchiver / binary plist that carries the same LPLinkMetadata
fields the parser looks for. Confirm live blobs on a Mac after deploying.
"""
import os
import plistlib
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
# 2026-09-25 21:25:00 in America/Los_Angeles (PDT, UTC-7).
BASE_UTC = datetime(2026, 9, 26, 4, 25, 0, tzinfo=timezone.utc)

GUID = {
    100: "A1000000-0000-4000-8000-000000000100",
    101: "A1000000-0000-4000-8000-000000000101",
    102: "A1000000-0000-4000-8000-000000000102",
    103: "A1000000-0000-4000-8000-000000000103",
    104: "A1000000-0000-4000-8000-000000000104",
    105: "A1000000-0000-4000-8000-000000000105",
    106: "A1000000-0000-4000-8000-000000000106",
    107: "A1000000-0000-4000-8000-000000000107",
    108: "A1000000-0000-4000-8000-000000000108",
    111: "A1000000-0000-4000-8000-000000000111",
    200: "A1000000-0000-4000-8000-000000000200",
    201: "A1000000-0000-4000-8000-000000000201",
    202: "A1000000-0000-4000-8000-000000000202",
    203: "A1000000-0000-4000-8000-000000000203",
    204: "A1000000-0000-4000-8000-000000000204",
    205: "A1000000-0000-4000-8000-000000000205",
    206: "A1000000-0000-4000-8000-000000000206",
}

SPOTIFY_URL = "https://open.spotify.com/track/spice-melange"
GAZETTE_URL = "https://www.arrakis.example/spice"
CHANI = "+15550199480"
PAUL = "paul@caladan.org"


def apple_ns(offset_minutes=0):
    moment = BASE_UTC + timedelta(minutes=offset_minutes)
    return int((moment - APPLE_EPOCH).total_seconds() * 1_000_000_000)


def attributed_body(text):
    """Minimal attributedBody blob that parse_attributed_body() accepts."""
    raw = text.encode("utf-8")
    marker = b"NSString" + bytes([1, 148, 132, 1]) + b"+"
    return marker + bytes([len(raw)]) + raw


def keyed_spotify_payload():
    """NSKeyedArchiver-style LPLinkMetadata with an artist specialization."""
    objects = [
        "$null",
        {
            "$class": plistlib.UID(7),
            "URL": plistlib.UID(2),
            "originalURL": plistlib.UID(2),
            "title": plistlib.UID(3),
            "summary": plistlib.UID(4),
            "siteName": plistlib.UID(5),
            "specialization": plistlib.UID(9),
        },
        {
            "$class": plistlib.UID(8),
            "NS.base": plistlib.UID(0),
            "NS.relative": plistlib.UID(6),
        },
        "Fear is the Mind-Killer",
        "Paul Atreides",
        "Spotify",
        SPOTIFY_URL,
        {"$classname": "LPLinkMetadata", "$classes": ["LPLinkMetadata", "NSObject"]},
        {"$classname": "NSURL", "$classes": ["NSURL", "NSObject"]},
        {
            "$class": plistlib.UID(11),
            "artist": plistlib.UID(10),
            "album": plistlib.UID(4),
        },
        "Paul Atreides",
        {
            "$classname": "LPAppleMusicMetadata",
            "$classes": ["LPAppleMusicMetadata", "LPSpecializationMetadata", "NSObject"],
        },
    ]
    archive = {
        "$version": 100000,
        "$archiver": "NSKeyedArchiver",
        "$top": {"root": plistlib.UID(1)},
        "$objects": objects,
    }
    return plistlib.dumps(archive, fmt=plistlib.FMT_BINARY)


def flat_gazette_payload():
    return plistlib.dumps(
        {
            "URL": GAZETTE_URL,
            "title": "Spice Melange",
            "summary": "The spice must flow",
            "siteName": "Arrakis Gazette",
        },
        fmt=plistlib.FMT_BINARY,
    )


def edit_summary_blob():
    original_sec = (BASE_UTC - APPLE_EPOCH).total_seconds() + 7 * 60
    edited_sec = original_sec + 120
    payload = {
        "ec": {
            "0": [
                {"d": original_sec, "t": attributed_body("Original spice report")},
                {"d": edited_sec, "t": attributed_body("Revised spice report")},
            ]
        }
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_BINARY)


def build(path):
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.executescript(
        """
        CREATE TABLE handle (
            ROWID INTEGER PRIMARY KEY,
            id TEXT,
            service TEXT
        );
        CREATE TABLE chat (
            ROWID INTEGER PRIMARY KEY,
            guid TEXT,
            chat_identifier TEXT,
            display_name TEXT,
            service_name TEXT
        );
        CREATE TABLE message (
            ROWID INTEGER PRIMARY KEY,
            guid TEXT UNIQUE,
            text TEXT,
            attributedBody BLOB,
            handle_id INTEGER,
            date INTEGER,
            date_edited INTEGER,
            is_from_me INTEGER,
            is_audio_message INTEGER,
            message_summary_info BLOB,
            associated_message_guid TEXT,
            associated_message_type INTEGER DEFAULT 0,
            associated_message_emoji TEXT,
            balloon_bundle_id TEXT,
            payload_data BLOB,
            cache_has_attachments INTEGER DEFAULT 0,
            item_type INTEGER DEFAULT 0,
            is_delivered INTEGER DEFAULT 0,
            date_delivered INTEGER DEFAULT 0,
            is_read INTEGER DEFAULT 0,
            date_read INTEGER DEFAULT 0,
            reply_to_guid TEXT,
            thread_originator_guid TEXT,
            was_delivered_quietly INTEGER DEFAULT 0,
            did_notify_recipient INTEGER DEFAULT 0,
            expressive_send_style_id TEXT,
            time_expressive_send_played INTEGER,
            schedule_type INTEGER DEFAULT 0,
            schedule_state INTEGER DEFAULT 0,
            is_played INTEGER DEFAULT 0,
            date_played INTEGER DEFAULT 0,
            date_retracted INTEGER DEFAULT 0,
            is_time_sensitive INTEGER DEFAULT 0,
            is_kt_verified INTEGER DEFAULT 0,
            sent_or_received_off_grid INTEGER DEFAULT 0
        );
        CREATE TABLE chat_message_join (
            chat_id INTEGER,
            message_id INTEGER,
            message_date INTEGER
        );
        CREATE TABLE chat_handle_join (
            chat_id INTEGER,
            handle_id INTEGER
        );
        CREATE TABLE attachment (
            ROWID INTEGER PRIMARY KEY,
            guid TEXT,
            filename TEXT,
            mime_type TEXT,
            transfer_name TEXT,
            total_bytes INTEGER,
            user_info BLOB,
            uti TEXT
        );
        CREATE TABLE message_attachment_join (
            message_id INTEGER,
            attachment_id INTEGER
        );
        CREATE INDEX idx_cmj_chat_message ON chat_message_join(chat_id, message_id);
        CREATE INDEX idx_message_guid ON message(guid);
        CREATE INDEX idx_message_assoc ON message(associated_message_type);
        """
    )

    c.execute("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')", (CHANI,))
    c.execute("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')", (PAUL,))
    c.execute(
        "INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name) VALUES (7, ?, ?, 'Chani', 'iMessage')",
        ("iMessage;-;chani", CHANI),
    )
    c.execute(
        "INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name) VALUES (8, ?, ?, 'Paul Atreides', 'iMessage')",
        ("iMessage;-;paul", PAUL),
    )
    c.execute("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (7, 1)")
    c.execute("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (8, 2)")

    def add_message(
        rowid,
        chat_id,
        handle_id,
        is_from_me,
        text,
        offset,
        assoc_type=0,
        assoc_guid=None,
        assoc_emoji=None,
        balloon=None,
        payload=None,
        summary=None,
        date_edited=0,
        is_delivered=0,
        date_delivered=0,
        is_read=0,
        date_read=0,
        reply_to_guid=None,
        thread_originator_guid=None,
        was_delivered_quietly=0,
        did_notify_recipient=0,
        expressive_send_style_id=None,
        time_expressive_send_played=0,
        schedule_type=0,
        schedule_state=0,
        is_audio_message=0,
        is_played=0,
        date_played=0,
        date_retracted=0,
        is_time_sensitive=0,
        is_kt_verified=0,
        sent_or_received_off_grid=0,
    ):
        date_ns = apple_ns(offset)
        c.execute(
            """
            INSERT INTO message (
                ROWID, guid, text, handle_id, date, date_edited, is_from_me,
                is_audio_message, message_summary_info, associated_message_guid,
                associated_message_type, associated_message_emoji, balloon_bundle_id,
                payload_data, cache_has_attachments, item_type,
                is_delivered, date_delivered, is_read, date_read,
                reply_to_guid, thread_originator_guid,
                was_delivered_quietly, did_notify_recipient,
                expressive_send_style_id, time_expressive_send_played,
                schedule_type, schedule_state,
                is_played, date_played, date_retracted,
                is_time_sensitive, is_kt_verified, sent_or_received_off_grid
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rowid,
                GUID[rowid],
                text,
                handle_id,
                date_ns,
                date_edited,
                is_from_me,
                is_audio_message,
                summary,
                assoc_guid,
                assoc_type,
                assoc_emoji,
                balloon,
                payload,
                1 if payload else 0,
                is_delivered,
                date_delivered,
                is_read,
                date_read,
                reply_to_guid,
                thread_originator_guid,
                was_delivered_quietly,
                did_notify_recipient,
                expressive_send_style_id,
                time_expressive_send_played,
                schedule_type,
                schedule_state,
                is_played,
                date_played,
                date_retracted,
                is_time_sensitive,
                is_kt_verified,
                sent_or_received_off_grid,
            ),
        )
        c.execute(
            "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
            (chat_id, rowid, date_ns),
        )

    # Outgoing rows intentionally store Chani's handle_id, matching chat.db.
    add_message(100, 7, 1, 0, "The spice must flow", 0, is_read=1, date_read=apple_ns(0))
    add_message(
        101,
        7,
        1,
        1,
        "Acknowledged",
        1,
        is_delivered=1,
        date_delivered=apple_ns(1) + 1_000_000_000,
        is_read=1,
        date_read=apple_ns(1) + 5_000_000_000,
        reply_to_guid=GUID[100],
    )
    add_message(
        102,
        7,
        1,
        0,
        SPOTIFY_URL,
        2,
        balloon="com.apple.messages.URLBalloonProvider",
        payload=keyed_spotify_payload(),
    )
    add_message(
        103,
        7,
        1,
        0,
        "Loved “The spice must flow”",
        3,
        assoc_type=2000,
        assoc_guid=f"p:0/{GUID[100]}",
    )
    add_message(
        104,
        7,
        1,
        1,
        f"Liked “{SPOTIFY_URL}”",
        4,
        assoc_type=2001,
        assoc_guid=f"p:0/{GUID[102]}",
    )
    add_message(105, 7, 1, 0, "See you on Caladan", 5)
    add_message(
        106,
        7,
        1,
        0,
        "Reacted 🪱 to “See you on Caladan”",
        6,
        assoc_type=2006,
        assoc_guid=f"p:0/{GUID[105]}",
        assoc_emoji="🪱",
    )
    add_message(
        107,
        7,
        1,
        1,
        "Revised spice report",
        7,
        summary=edit_summary_blob(),
        date_edited=apple_ns(9),
        is_delivered=1,
        date_delivered=apple_ns(7) + 2_000_000_000,
        is_read=0,
        date_read=0,
        thread_originator_guid=GUID[105],
    )
    add_message(
        108,
        7,
        1,
        0,
        "Removed a heart from “The spice must flow”",
        8,
        assoc_type=3000,
        assoc_guid=f"p:0/{GUID[100]}",
    )
    # ROWID 109 is intentionally absent so a hole is not reported as a filtered row.
    add_message(
        111,
        7,
        1,
        0,
        GAZETTE_URL,
        11,
        balloon="com.apple.messages.URLBalloonProvider",
        payload=flat_gazette_payload(),
    )
    add_message(200, 8, 2, 0, "Unrelated Harkonnen rumor", 20)
    add_message(201, 8, 2, 0, "Look at this sandworm", 21)
    add_message(
        202,
        8,
        2,
        1,
        "Desert power",
        22,
        is_delivered=1,
        date_delivered=0,
        was_delivered_quietly=1,
        did_notify_recipient=0,
    )
    add_message(
        203,
        8,
        2,
        1,
        "Bless the Maker and His water",
        23,
        is_delivered=1,
        date_delivered=0,
        was_delivered_quietly=1,
        did_notify_recipient=1,
    )
    add_message(
        204,
        8,
        2,
        1,
        "Shai-Hulud approaches with lasers",
        24,
        is_delivered=1,
        date_delivered=apple_ns(24),
        expressive_send_style_id="com.apple.messages.effect.CKLasersEffect",
        is_time_sensitive=1,
    )
    add_message(
        205,
        8,
        2,
        1,
        "Send later across the dunes",
        25,
        is_delivered=0,
        date_delivered=0,
        schedule_type=1,
        schedule_state=1,
    )
    add_message(
        206,
        8,
        2,
        0,
        "Played voice memo",
        26,
        is_audio_message=1,
        is_played=1,
        date_played=apple_ns(26),
    )

    c.execute(
        """
        INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes, uti)
        VALUES (1, ?, ?, 'application/octet-stream', 'pluginPayloadAttachment', 128, ?)
        """,
        (
            "ATT-SPOTIFY-1",
            "~/Library/Messages/Attachments/aa/bb/SPICE-PREVIEW/pluginPayloadAttachment",
            "com.apple.messages.pluginPayloadAttachment",
        ),
    )
    c.execute("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (102, 1)")

    img_fixture_path = os.path.join(os.path.dirname(__file__), "shai_hulud.jpg")
    img_size = os.path.getsize(img_fixture_path) if os.path.exists(img_fixture_path) else 623
    c.execute(
        """
        INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes, uti)
        VALUES (2, ?, ?, 'image/jpeg', 'shai_hulud.jpg', ?, 'public.jpeg')
        """,
        (
            "ATT-SHAI-HULUD-1",
            img_fixture_path,
            img_size,
        ),
    )
    c.execute("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (201, 2)")
    conn.commit()
    conn.close()


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "chat.db")
    build(dest)
    print(dest)


if __name__ == "__main__":
    main()
