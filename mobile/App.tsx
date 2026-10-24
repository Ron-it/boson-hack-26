import { useCallback, useEffect, useReducer, useState } from 'react';
import { AppState, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';
import Audio from './modules/boson-audio/src/BosonAudioModule';

const eventSchema = z.object({
  type: z.string(), state: z.string().optional(), detail: z.string().optional(),
  goal: z.string().optional(), message: z.string().optional(), mode: z.enum(['do', 'guide']).optional(),
  transcript: z.string().optional(), delta: z.string().optional(), response_id: z.string().optional(),
});
type Event = z.infer<typeof eventSchema>;
const initialSession = { active: false, state: 'Ready when you are', error: '', goal: '', task: '', mode: 'do', screen: '', user: '', assistant: '', response: '' };
function reduceSession(state: typeof initialSession, event: Event) {
  if (event.type === 'reset') return initialSession;
  if (event.type === 'notice') return { ...state, error: event.message || '' };
  if (event.type === 'state') {
    if (event.state === 'error') return { ...state, active: false, error: event.detail || 'Please try again.' };
    if (event.state === 'stopped') return { ...state, active: false, state: 'Session ended' };
    return { ...state, active: true, state: event.detail || 'Listening' };
  }
  if (event.type === 'task') return { ...state, goal: event.goal || '', task: event.state === 'completed' ? 'Done' : event.detail || '' };
  if (event.type === 'help') {
    const screen = event.state === 'unavailable' ? `Can't see this screen. ${event.detail || ''}` : event.detail;
    return { ...state, mode: event.mode || state.mode, screen: screen ?? state.screen };
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') return { ...state, user: event.transcript || '' };
  if (event.type === 'response.output_audio_transcript.done') return { ...state, assistant: event.transcript || '' };
  if (event.type === 'response.output_audio_transcript.delta') return { ...state, response: event.response_id || '', assistant: (event.response_id === state.response ? state.assistant : '') + (event.delta || '') };
  return state;
}

const schemes = {
  light: { surface: '#F4F8F5', text: '#142D28', secondary: '#47645B', primary: '#006B55', onPrimary: '#FFFFFF', input: '#E4EEE7', error: '#A32225' },
  dark: { surface: '#10251F', text: '#E2F2E7', secondary: '#ADCABB', primary: '#7BDBB5', onPrimary: '#00382A', input: '#203C31', error: '#FFB4AB' },
};

function PhoneScreen() {
  const insets = useSafeAreaInsets();
  const colors = schemes[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const [session, dispatch] = useReducer(reduceSession, initialSession);
  const [config, setConfig] = useState(() => Audio.configuration());
  const [url, setUrl] = useState(config.url);
  const [token, setToken] = useState('');
  const [setup, setSetup] = useState(!config.configured);
  const [brightness, setBrightness] = useState(() => Audio.canSetBrightness());

  const consume = useCallback((json: string) => {
    try { const parsed = eventSchema.safeParse(JSON.parse(json)); if (parsed.success) dispatch(parsed.data); } catch { /* Native event was incomplete. */ }
  }, []);
  useEffect(() => {
    const refresh = () => {
      setBrightness(Audio.canSetBrightness());
      try {
        const values = z.record(z.string(), z.string()).parse(JSON.parse(Audio.snapshot()));
        for (const [key, json] of Object.entries(values)) if (!key.endsWith('.delta')) consume(json);
      } catch { /* No prior session. */ }
    };
    const events = Audio.addListener('onEvent', event => consume(event.json));
    const appState = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    refresh();
    return () => { events.remove(); appState.remove(); };
  }, [consume]);

  const start = async () => {
    dispatch({ type: 'reset' });
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow the microphone to start a voice session.');
      if (Number(Platform.Version) >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      Audio.start();
    } catch (error) { dispatch({ type: 'notice', message: error instanceof Error ? error.message : 'Could not start the session.' }); }
  };
  const save = () => {
    try { Audio.configure(url.trim(), token.trim()); setConfig(Audio.configuration()); setToken(''); setSetup(false); dispatch({ type: 'reset' }); }
    catch (error) { dispatch({ type: 'notice', message: error instanceof Error ? error.message : 'Check the connection details.' }); }
  };

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.surface }} behavior="height">
    <StatusBar style={useColorScheme() === 'dark' ? 'light' : 'dark'} />
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Phone voice</Text>
      <Text style={[styles.supporting, { color: colors.secondary }]}>Speak. Watch it happen. Change your mind.</Text>
      <View accessibilityLiveRegion="polite" style={styles.session}>
        <Text style={[styles.headline, { color: colors.text }]}>{session.state}</Text>
        <Text style={[styles.body, { color: colors.secondary }]}>{!session.active ? 'Try “Help me with this” or “Turn on Night Light.”' : session.mode === 'guide' ? 'Showing you how. I won’t touch the phone.' : 'Your microphone stays on in other apps. You can interrupt at any time.'}</Text>
        {!!session.screen && <Text style={[styles.body, { color: colors.text }]}>{session.screen}</Text>}
      </View>
      {!!session.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{session.error}</Text>}
      <Pressable accessibilityRole="button" disabled={!config.configured && !session.active} onPress={session.active ? () => Audio.stop() : start} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: pressed ? 0.75 : !config.configured ? 0.45 : 1 }]}>
        <Text style={[styles.buttonText, { color: colors.onPrimary }]}>{session.active ? 'Stop listening' : 'Start listening'}</Text>
      </Pressable>
      {!session.active && <Text style={[styles.caption, { color: colors.secondary }]}>Audio goes to Boson. The screen is read only when you ask for help or a task.</Text>}
      {!!session.goal && <View style={styles.section}>
        <Text style={[styles.label, { color: colors.secondary }]}>Current request</Text>
        <Text style={[styles.body, { color: colors.text }]}>{session.goal}</Text>
        <Text style={[styles.body, { color: colors.secondary }]}>{session.task}</Text>
      </View>}
      {(!!session.user || !!session.assistant) && <View style={styles.section}>
        {!!session.user && <><Text style={[styles.label, { color: colors.secondary }]}>You</Text><Text selectable style={[styles.body, { color: colors.text }]}>{session.user}</Text></>}
        {!!session.assistant && <><Text style={[styles.label, { color: colors.secondary, marginTop: 16 }]}>{session.assistant.trim().endsWith('?') ? 'Question' : 'Phone'}</Text><Text selectable style={[styles.body, { color: colors.text }]}>{session.assistant}</Text></>}
      </View>}
      {!session.active && <View style={styles.section}>
        <Pressable accessibilityRole="button" style={styles.textButton} onPress={() => Audio.requestBrightnessPermission()}><Text style={[styles.buttonText, { color: colors.primary }]}>{brightness ? 'Brightness control enabled' : 'Enable instant brightness control'}</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.textButton} onPress={() => setSetup(value => !value)}><Text style={[styles.buttonText, { color: colors.primary }]}>{setup ? 'Hide connection' : 'Connection settings'}</Text></Pressable>
        {setup && <View style={styles.fields}>
          <Text style={[styles.label, { color: colors.text }]}>Server address</Text>
          <TextInput accessibilityLabel="Server address" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://your-server" placeholderTextColor={colors.secondary} style={[styles.input, { color: colors.text, backgroundColor: colors.input }]} />
          <Text style={[styles.label, { color: colors.text }]}>Device pairing code</Text>
          <TextInput accessibilityLabel="Device pairing code" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholderTextColor={colors.secondary} style={[styles.input, { color: colors.text, backgroundColor: colors.input }]} />
          <Pressable accessibilityRole="button" onPress={save} style={[styles.primary, { backgroundColor: colors.primary }]}><Text style={[styles.buttonText, { color: colors.onPrimary }]}>Save connection</Text></Pressable>
        </View>}
      </View>}
    </ScrollView>
  </KeyboardAvoidingView>;
}

export default function App() { return <SafeAreaProvider><PhoneScreen /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  page: { paddingHorizontal: 24, flexGrow: 1 },
  title: { fontSize: 28, lineHeight: 36, fontWeight: '600' },
  supporting: { fontSize: 16, lineHeight: 24, marginTop: 8 },
  session: { marginTop: 48, marginBottom: 24, gap: 12 },
  headline: { fontSize: 32, lineHeight: 40, fontWeight: '500' },
  body: { fontSize: 17, lineHeight: 26 },
  caption: { fontSize: 13, lineHeight: 20, marginTop: 12 },
  primary: { minHeight: 56, paddingHorizontal: 24, paddingVertical: 16, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  buttonText: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  section: { marginTop: 32, gap: 8 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  textButton: { minHeight: 48, justifyContent: 'center', paddingVertical: 12 },
  fields: { gap: 8, paddingTop: 16 },
  input: { minHeight: 56, borderRadius: 4, paddingHorizontal: 16, fontSize: 16 },
});
