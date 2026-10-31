# Changelog

## 0.4.30
- Removed Muse Listen and Desk (test) completely: their Home rows, the glasses menu item (the menu is back to 9 items), their screens and code, the head-tracking (IMU) code only the Desk used, and the Desk's phone-page switches. Old saved settings and Tiles layouts that mention them load cleanly (unknown settings are ignored, their tiles become empty tiles).

## 0.4.8
- Renamed to "G2 OMAC" (store name, phone page title, pairing and status texts). New icon. The package id stays `com.piebird.home`.

## 0.4.7
- Phone remote: while the app is in front, one long-poll to the current hub brings the phone's up/down/select/back buttons; each goes through the same handler as a glasses gesture.
