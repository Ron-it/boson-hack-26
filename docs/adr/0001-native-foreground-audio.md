# Keep audio ownership in a native foreground service

The Android demo must keep listening while Settings is foreground and must flush
spoken audio immediately when interrupted. Use Expo for the interface and a local
Kotlin module whose foreground service owns microphone, speaker, and connection
lifetime. SDK58 expo-audio offers raw PCM capture and background recording, but
the reviewed playback API does not establish an appendable PCM sink with queue
flush; replacing the entire transport with it would leave that requirement unresolved.

Keep module source outside generated Android projects and apply build settings
through Expo config plugins. This choice requires a native APK, not Expo Go.
The API choice does not certify audio correctness: the first buffer failure was
reproduced and repaired separately, and spoken device acceptance is still pending.
See the [Expo audit](../expo-audit.md) for primary sources and the [runtime](../runtime.md)
for the implemented boundaries.
