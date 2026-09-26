#!/usr/bin/env python3
"""Build a synthetic CallHistory.storedata for call history tests.

The fixture is shaped like macOS Core Data's CallHistory.storedata (ZCALLRECORD table).
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
# 2026-09-25 21:25:00 in America/Los_Angeles (PDT, UTC-7). Matches build_chat_db.py.
BASE_UTC = datetime(2026, 9, 26, 4, 25, 0, tzinfo=timezone.utc)

CHANI = "+15550199480"
PAUL = "paul@caladan.org"
BARON = "+15550199999"


def apple_seconds(offset_minutes=0):
    moment = BASE_UTC + timedelta(minutes=offset_minutes)
    return float((moment - APPLE_EPOCH).total_seconds())


def build(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    c.execute(
        """
        CREATE TABLE ZCALLRECORD (
            Z_PK INTEGER PRIMARY KEY,
            Z_ENT INTEGER DEFAULT 1,
            Z_OPT INTEGER DEFAULT 1,
            ZANSWERED INTEGER DEFAULT 0,
            ZCALLTYPE INTEGER DEFAULT 1,
            ZORIGINATED INTEGER DEFAULT 0,
            ZDATE TIMESTAMP DEFAULT 0,
            ZDURATION FLOAT DEFAULT 0.0,
            ZADDRESS VARCHAR,
            ZNAME VARCHAR,
            ZSERVICE_PROVIDER VARCHAR,
            ZUNIQUE_ID VARCHAR
        );
        """
    )

    records = [
        # 1. Incoming phone call from Chani, answered, 120s
        (1, 1, 0, apple_seconds(2), 120.0, CHANI, "Chani", "com.apple.Telephony", "CALL-0001"),
        # 2. Incoming phone call from Chani, missed, 0s
        (2, 1, 0, apple_seconds(5), 0.0, CHANI, "Chani", "com.apple.Telephony", "CALL-0002"),
        # 3. Outgoing phone call to Chani, answered, 45s
        (3, 1, 1, apple_seconds(7), 45.0, CHANI, "Chani", "com.apple.Telephony", "CALL-0003"),
        # 4. Incoming FaceTime video from Chani, answered, 300s
        (4, 8, 0, apple_seconds(10), 300.0, CHANI, "Chani", "com.apple.FaceTime", "CALL-0004"),
        # 5. Outgoing FaceTime audio to Paul, answered, 90s
        (5, 16, 1, apple_seconds(12), 90.0, PAUL, "Paul Atreides", "com.apple.FaceTime", "CALL-0005"),
        # 6. Incoming call with unknown call type 99 from Baron
        (6, 99, 0, apple_seconds(15), 15.0, BARON, "Baron Harkonnen", "com.telecom.spice", "CALL-0006"),
        # 7. Incoming FaceTime video from Chani, missed, 0s
        (7, 8, 0, apple_seconds(18), 0.0, CHANI, "Chani", "com.apple.FaceTime", "CALL-0007"),
    ]

    for pk, calltype, orig, date_s, dur, addr, name, prov, uid in records:
        c.execute(
            """
            INSERT INTO ZCALLRECORD (
                Z_PK, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZDATE, ZDURATION,
                ZADDRESS, ZNAME, ZSERVICE_PROVIDER, ZUNIQUE_ID
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                pk,
                1 if (dur > 0 and orig == 0) or orig == 1 else 0,
                calltype,
                orig,
                date_s,
                dur,
                addr,
                name,
                prov,
                uid,
            ),
        )

    conn.commit()
    conn.close()


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "CallHistory.storedata")
    build(dest)
    print(dest)


if __name__ == "__main__":
    main()
