import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react';
import { AppState, BackHandler, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { z } from 'zod';
import Audio from './modules/boson-audio/src/BosonAudioModule';

const eventSchema = z.object({
  type: z.string(), state: z.string().nullish(), detail: z.string().nullish(),
  goal: z.string().nullish(), message: z.string().nullish(), mode: z.enum(['do', 'guide']).nullish(),
  transcript: z.string().nullish(), delta: z.string().nullish(), response_id: z.string().nullish(),
  proposal: z.object({ operation: z.string(), app: z.string().nullish(), recipient: z.string().nullish(), message: z.string().nullish() }).nullish(),
});
type Event = z.infer<typeof eventSchema>;
type Proposal = NonNullable<Event['proposal']>;
const taskLabels: Record<string, string> = {
  working: 'Working', paused: 'Paused', confirming: 'Waiting for your OK', question: 'Needs your answer',
  declined: 'Declined', completed: 'Done', blocked: 'Stopped', unknown: 'Outcome unknown',
};
const initialSession = { active: false, state: '', error: '', goal: '', task: '', taskState: '', proposal: null as Proposal | null, mode: 'do', screen: '', user: '', assistant: '', response: '' };
function reduceSession(state: typeof initialSession, event: Event) {
  if (event.type === 'reset') return initialSession;
  if (event.type === 'notice') return { ...state, error: event.message || '' };
  if (event.type === 'state') {
    if (event.state === 'error') return { ...state, active: false, error: event.detail || 'Please try again.' };
    if (event.state === 'stopped') return { ...state, active: false, state: '' };
    return { ...state, active: true, error: '', state: event.detail || 'Listening' };
  }
  if (event.type === 'task') return { ...state, goal: event.goal || '', task: event.detail || '', taskState: event.state ?? '', proposal: event.state === 'confirming' ? event.proposal ?? null : null };
  if (event.type === 'help') {
    const screen = event.state === 'unavailable' ? `Can't see this screen. ${event.detail || ''}` : event.detail;
    return { ...state, mode: event.mode || state.mode, screen: screen ?? state.screen };
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') return { ...state, user: event.transcript || '' };
  if (event.type === 'response.output_audio_transcript.done') return { ...state, assistant: event.transcript || '' };
  if (event.type === 'response.output_audio_transcript.delta') return { ...state, response: event.response_id || '', assistant: (event.response_id === state.response ? state.assistant : '') + (event.delta || '') };
  return state;
}
type Session = ReturnType<typeof reduceSession>;

const presets = [
  { id: 'quick', label: 'Quick', hint: 'Short answers. Gets it done fast.' },
  { id: 'family', label: 'Family', hint: '' },
  { id: 'hands_free', label: 'Hands-free', hint: 'Does the tapping for you.' },
] as const;
const presetSchema = z.enum(presets.map(preset => preset.id)).catch('quick');

/** Family speaks one of these, in the helper's voice. The helper reads `sample` aloud; it is also the transcript Boson needs. */
const familyLanguages = [
  { id: 'hi', label: 'हिन्दी', name: 'Hindi', sample: 'नमस्ते, कैसे हो आप? मैं आपकी मदद के लिए यहाँ हूँ। आराम से बताइए, फ़ोन पर क्या करना है? हम एक एक करके सब कर लेंगे। कोई जल्दी नहीं है। अगर कुछ समझ न आए तो मुझसे फिर पूछ लेना।' },
  { id: 'en', label: 'English', name: 'English', sample: 'Hi, it’s me. How are you doing? I’m here to help you with your phone. Just tell me what you’d like to do, and we’ll go through it one step at a time. There’s no rush at all. If anything is unclear, just ask me again.' },
  { id: 'es', label: 'Español', name: 'Spanish', sample: 'Hola, soy yo. ¿Cómo estás? Estoy aquí para ayudarte con el teléfono. Dime con calma qué quieres hacer y lo haremos paso a paso. No hay ninguna prisa. Si algo no queda claro, pregúntame otra vez.' },
  { id: 'fr', label: 'Français', name: 'French', sample: 'Bonjour, c’est moi. Comment ça va ? Je suis là pour t’aider avec ton téléphone. Dis-moi tranquillement ce que tu veux faire, et on le fera étape par étape. Rien ne presse. Si quelque chose n’est pas clair, demande-moi encore.' },
  { id: 'de', label: 'Deutsch', name: 'German', sample: 'Hallo, ich bin’s. Wie geht es dir? Ich bin hier, um dir mit dem Handy zu helfen. Sag mir in Ruhe, was du machen möchtest, und wir gehen es Schritt für Schritt durch. Es gibt keine Eile. Wenn etwas unklar ist, frag mich einfach noch einmal.' },
  { id: 'zh', label: '中文', name: 'Mandarin', sample: '你好，是我。你最近好吗？我在这里帮你用手机。慢慢告诉我你想做什么，我们一步一步来。一点都不着急。如果有什么不明白的，再问我就好。' },
] as const;
type FamilyLanguage = typeof familyLanguages[number];
const familyLanguage = (id: string): FamilyLanguage => familyLanguages.find(language => language.id === id) ?? familyLanguages[0];
const minSeconds = 5;
const maxSeconds = 30;

/** Boson AI foundations. Green marks the primary action and a live session, nothing else. */
const colors = {
  canvas: '#0D1012', surface: '#161819', raised: '#1C2022', text: '#EFF0F0', strong: '#F4F5F5', secondary: '#BFC1C2', muted: '#999B9C',
  controlBorder: '#60696D', accent: '#2BCB3A', accentPressed: '#21B82F', onAccent: '#0D1012', greenSoft: '#8CC4A4', error: '#FF9B93',
};
const taskColors: Record<string, string> = { working: colors.accent, completed: colors.accent, blocked: colors.error, unknown: colors.error };

function Mark({ size }: { size: number }) {
  return <Svg width={size} height={size} viewBox="28 28 52 52">
    <Circle cx={44} cy={54} r={11} fill={colors.strong} />
    <Path d="M60.7 34.1 A26 26 0 0 1 60.7 73.9" fill="none" stroke={colors.accent} strokeWidth={10} strokeLinecap="round" />
  </Svg>;
}

function Button({ label, onPress, tone, disabled, icon }: { label: string; onPress: () => void; tone: 'accent' | 'neutral'; disabled?: boolean; icon?: ReactNode }) {
  const accent = tone === 'accent';
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { backgroundColor: accent ? (pressed ? colors.accentPressed : colors.accent) : (pressed ? colors.surface : colors.raised), opacity: disabled ? 0.4 : 1 }]}>
    {icon}
    <Text style={[styles.buttonText, { color: accent ? colors.onAccent : colors.strong }]}>{label}</Text>
  </Pressable>;
}

function Home({ session, preset, onPreset, configured, family, onStart, onSettings }: { session: Session; preset: string; onPreset: (id: typeof presets[number]['id']) => void; configured: boolean; family: { language: FamilyLanguage; voice: boolean }; onStart: () => void; onSettings: () => void }) {
  const hint = preset === 'family'
    ? `Patient, and speaks ${family.language.name}${family.voice ? ' in your voice' : ''}.`
    : presets.find(option => option.id === preset)?.hint;
  return <>
    <View style={styles.topBar}>
      <View style={styles.lockup}><Mark size={22} /><Text accessibilityRole="header" style={styles.wordmark}>Tandem</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} style={styles.iconButton}>
        <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={colors.secondary} strokeWidth={1.75} strokeLinecap="round">
          <Path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><Circle cx={16} cy={7} r={2} /><Circle cx={8} cy={17} r={2} />
        </Svg>
      </Pressable>
    </View>
    <View style={styles.main}>
      <Text style={styles.display}>What do you need help with?</Text>
      <Text style={styles.lead}>Open any app and say “help me with this.”</Text>
    </View>
    {!!session.error && <Text accessibilityRole="alert" style={[styles.body, styles.inset, { color: colors.error, paddingBottom: 16 }]}>{session.error}</Text>}
    <View style={styles.inset}>
      <View accessibilityRole="radiogroup" style={styles.tabs}>
        {presets.map(option => <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: preset === option.id }} onPress={() => onPreset(option.id)}
          style={[styles.tab, { borderBottomColor: preset === option.id ? colors.accent : 'transparent' }]}>
          <Text style={[styles.tabText, { color: preset === option.id ? colors.strong : colors.muted }]}>{option.label}</Text>
        </Pressable>)}
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </View>
    <View style={styles.actions}>
      {configured
        ? <Button tone="accent" label="Start talking" onPress={onStart} icon={<Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={colors.onAccent} strokeWidth={2} strokeLinecap="round"><Rect x={9} y={3} width={6} height={11} rx={3} /><Path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>} />
        : <Button tone="accent" label="Pair this phone" onPress={onSettings} />}
      <Text style={styles.caption}>{configured ? 'Tandem only looks at your screen when you ask.' : 'Add your server address and pairing code to start.'}</Text>
    </View>
  </>;
}

function Live({ session }: { session: Session }) {
  const { proposal } = session;
  const confirming = session.taskState === 'confirming';
  const message = confirming && proposal?.operation === 'send_message' && proposal.message ? proposal : null;
  return <>
    <View style={styles.topBar}>
      <View style={styles.lockup}><Mark size={22} /><Text style={styles.wordmark}>Tandem</Text></View>
      <View style={[styles.lockup, { paddingRight: 12 }]}>
        <View style={styles.liveDot} />
        <Text style={styles.liveText}>{confirming ? 'Waiting for you' : session.state}</Text>
      </View>
    </View>
    <View accessibilityLiveRegion="polite" style={[styles.main, { gap: 24 }]}>
      {message ? <>
        <Text style={styles.headline}>Send this to {message.recipient}?</Text>
        <View style={styles.quote}>
          <Text style={styles.quoteMeta}>{[message.app, message.recipient].filter(Boolean).join(' · ')}</Text>
          <Text selectable style={styles.quoteText}>{message.message}</Text>
        </View>
        <Text style={styles.body}>Say “yes” to send, or “no” to change it.</Text>
      </> : session.goal ? <>
        <Text style={styles.headline}>{session.goal}</Text>
        <View style={{ gap: 6 }}>
          <Text style={[styles.status, { color: taskColors[session.taskState] ?? colors.strong }]}>{taskLabels[session.taskState] ?? 'Working'}</Text>
          {!!session.task && <Text selectable style={styles.body}>{session.task}</Text>}
          {confirming && <Text style={styles.body}>Say “yes” to go ahead, or “no” to change it.</Text>}
        </View>
      </> : <>
        <Text style={styles.headline}>{session.user ? `“${session.user}”` : 'Go ahead, I’m listening.'}</Text>
      </>}
      {!!session.screen && <Text selectable style={styles.body}>{session.screen}</Text>}
      {!!session.assistant && !message && <View style={{ gap: 4 }}>
        <Text style={styles.label}>Tandem</Text>
        <Text selectable style={[styles.body, { color: colors.text }]}>{session.assistant}</Text>
      </View>}
    </View>
    {!!session.error && <Text accessibilityRole="alert" style={[styles.body, styles.inset, { color: colors.error }]}>{session.error}</Text>}
    <View style={styles.actions}>
      <Button tone="neutral" label="Stop" onPress={() => Audio.stop()} icon={<View style={styles.stopGlyph} />} />
      <Text style={styles.caption}>{session.mode === 'guide' ? 'Showing you how. Tandem won’t touch the phone.' : 'Talk over Tandem anytime to change what you asked.'}</Text>
    </View>
  </>;
}

type Recording = { state: 'idle' } | { state: 'recording'; seconds: number } | { state: 'saving' } | { state: 'failed'; error: string };

/** Pick Family's language, then record the helper reading a paragraph in it to clone their voice. */
function FamilyVoice({ configured, language, voiceLanguage, onChange }: { configured: boolean; language: FamilyLanguage; voiceLanguage: string; onChange: () => void }) {
  const [recording, setRecording] = useState<Recording>({ state: 'idle' });
  const busy = recording.state === 'recording' || recording.state === 'saving';
  const save = useCallback(async () => {
    setRecording({ state: 'saving' });
    const result = await Audio.saveSample(language.id, language.sample);
    setRecording('error' in result ? { state: 'failed', error: result.error } : { state: 'idle' });
    onChange();
  }, [language, onChange]);
  const seconds = recording.state === 'recording' ? recording.seconds : 0;
  useEffect(() => {
    if (recording.state !== 'recording') return;
    const tick = setInterval(() => setRecording(current => current.state === 'recording' ? { state: 'recording', seconds: current.seconds + 1 } : current), 1000);
    const limit = setTimeout(() => void save(), maxSeconds * 1000);
    return () => { clearInterval(tick); clearTimeout(limit); };
  }, [recording.state, save]);
  useEffect(() => () => Audio.cancelSample(), []);
  const record = async () => {
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow the microphone to record your voice.');
      Audio.startSample();
      setRecording({ state: 'recording', seconds: 0 });
    } catch (e) { setRecording({ state: 'failed', error: e instanceof Error ? e.message : 'Could not start recording.' }); }
  };
  const recorded = voiceLanguage ? familyLanguage(voiceLanguage) : null;
  const status = recording.state === 'recording'
    ? <View style={styles.lockup}><View style={styles.liveDot} /><Text style={styles.liveText}>Recording {`0:${String(seconds).padStart(2, '0')}`}</Text></View>
    : recording.state === 'saving'
      ? <Text style={[styles.rowDetail, { color: colors.secondary, fontSize: 15 }]}>Making your voice…</Text>
      : recorded
        ? <View style={{ flexShrink: 1 }}>
          <View style={styles.lockup}><Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12l5 5 9-10" /></Svg><Text style={[styles.rowDetail, { color: colors.greenSoft, fontSize: 15 }]}>Your voice</Text></View>
          {recorded.id !== language.id && <Text style={styles.rowDetail}>Recorded in {recorded.name}</Text>}
        </View>
        : <Text style={[styles.rowDetail, { fontSize: 15 }]}>{configured ? 'Standard voice' : 'Pair this phone to record'}</Text>;
  return <View style={{ paddingTop: 40 }}>
    <Text style={[styles.section, styles.inset]}>Family voice</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel="Family language" contentContainerStyle={[styles.tabs, styles.inset]}>
      {familyLanguages.map(option => {
        const checked = option.id === language.id;
        return <Pressable key={option.id} accessibilityRole="radio" accessibilityLabel={option.name} accessibilityState={{ checked, disabled: busy }} disabled={busy}
          onPress={() => { Audio.setFamilyLanguage(option.id); onChange(); }} style={[styles.tab, { borderBottomColor: checked ? colors.accent : 'transparent' }]}>
          <Text style={[styles.tabText, { color: checked ? colors.strong : colors.muted }]}>{option.label}</Text>
        </Pressable>;
      })}
    </ScrollView>
    <View style={[styles.inset, { paddingTop: 20, gap: 8 }]}>
      <Text style={styles.fieldLabel}>Read this aloud in your normal voice</Text>
      <Text style={[styles.quoteText, { color: recording.state === 'recording' ? colors.strong : colors.text }]}>{language.sample}</Text>
      {recording.state === 'failed' && <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{recording.error}</Text>}
      <View style={styles.saveRow}>
        {status}
        {recording.state === 'recording'
          ? <SmallButton label="Done" disabled={seconds < minSeconds} onPress={() => void save()} />
          : <SmallButton label={recorded ? 'Record again' : 'Record'} disabled={!configured || recording.state === 'saving'} onPress={() => void record()} />}
      </View>
      <Text style={[styles.caption, { textAlign: 'left', paddingTop: 8 }]}>Record only your own voice. Boson keeps it to speak as you.</Text>
    </View>
  </View>;
}

function SmallButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.smallButton, { backgroundColor: pressed ? colors.surface : colors.raised, opacity: disabled ? 0.4 : 1 }]}>
    <Text style={[styles.buttonText, { fontSize: 16, color: colors.strong }]}>{label}</Text>
  </Pressable>;
}

function Settings({ config, onSaved, onFamily, onBack }: { config: ReturnType<typeof Audio.configuration>; onSaved: () => void; onFamily: () => void; onBack: () => void }) {
  const { configured } = config;
  const [url, setUrl] = useState(() => Audio.configuration().url);
  const [token, setToken] = useState('');
  const [focus, setFocus] = useState<'url' | 'token' | null>(null);
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState(() => Audio.canShowOverlay());
  const [brightness, setBrightness] = useState(() => Audio.canSetBrightness());
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'active') { setOverlay(Audio.canShowOverlay()); setBrightness(Audio.canSetBrightness()); } });
    return () => sub.remove();
  }, []);
  const save = () => {
    try { Audio.configure(url.trim(), token.trim()); setToken(''); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Check the connection details.'); }
  };
  const permissions = [
    { title: 'Show over other apps', detail: 'So you can see Tandem while it works', on: overlay, request: () => Audio.requestOverlayPermission() },
    { title: 'Change brightness instantly', detail: 'Skips opening Settings for brightness', on: brightness, request: () => Audio.requestBrightnessPermission() },
  ];
  const field = (key: 'url' | 'token') => [styles.input, { borderColor: focus === key ? colors.accent : colors.controlBorder }];
  return <>
    <View style={[styles.topBar, { paddingLeft: 4, justifyContent: 'flex-start', gap: 4 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.iconButton}>
        <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><Path d="M19 12H5M11 6l-6 6 6 6" /></Svg>
      </Pressable>
      <Text accessibilityRole="header" style={styles.wordmark}>Settings</Text>
    </View>
    <View style={[styles.inset, { paddingTop: 16 }]}>
      <Text style={styles.section}>Permissions</Text>
      {permissions.map(item => <Pressable key={item.title} accessibilityRole="button" accessibilityHint={item.on ? undefined : 'Opens Android settings'} onPress={item.request} style={styles.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle}>{item.title}</Text>
          <Text style={styles.rowDetail}>{item.detail}</Text>
        </View>
        <Text style={[styles.rowState, item.on ? { color: colors.secondary, fontWeight: '500' } : { color: colors.accent }]}>{item.on ? 'On' : 'Turn on'}</Text>
      </Pressable>)}
    </View>
    <FamilyVoice configured={configured} language={familyLanguage(config.familyLanguage)} voiceLanguage={config.familyVoiceLanguage} onChange={onFamily} />
    <View style={[styles.inset, { paddingTop: 40, gap: 8 }]}>
      <Text style={styles.section}>Connection</Text>
      <Text style={styles.fieldLabel}>Server address</Text>
      <TextInput accessibilityLabel="Server address" value={url} onChangeText={setUrl} onFocus={() => setFocus('url')} onBlur={() => setFocus(null)} autoCapitalize="none" autoCorrect={false} keyboardType="url"
        placeholder="https://your-server" placeholderTextColor={colors.muted} selectionColor={colors.accent} style={field('url')} />
      <Text style={[styles.fieldLabel, { paddingTop: 8 }]}>Pairing code</Text>
      <TextInput accessibilityLabel="Pairing code" value={token} onChangeText={setToken} onFocus={() => setFocus('token')} onBlur={() => setFocus(null)} autoCapitalize="none" autoCorrect={false} secureTextEntry
        placeholder={configured ? 'Saved. Enter a new code to change it.' : ''} placeholderTextColor={colors.muted} selectionColor={colors.accent} style={field('token')} />
      {!!error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text>}
      <View style={styles.saveRow}>
        {configured
          ? <View style={styles.lockup}><Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12l5 5 9-10" /></Svg><Text style={[styles.rowDetail, { color: colors.greenSoft, fontSize: 15 }]}>Paired</Text></View>
          : <View />}
        <SmallButton label="Save" onPress={save} />
      </View>
    </View>
    <View style={[styles.main, { paddingBottom: 0 }]}>
      <Text style={[styles.caption, { textAlign: 'left' }]}>Tandem 1.0 · Voice by Boson Higgs Realtime. Audio goes to Boson while you talk.</Text>
    </View>
  </>;
}

function PhoneScreen() {
  const insets = useSafeAreaInsets();
  const [session, dispatch] = useReducer(reduceSession, initialSession);
  const [config, setConfig] = useState(() => Audio.configuration());
  const [settings, setSettings] = useState(false);
  const [preset, setPreset] = useState(() => presetSchema.parse(config.preset));

  const consume = useCallback((json: string) => {
    try { const parsed = eventSchema.safeParse(JSON.parse(json)); if (parsed.success) dispatch(parsed.data); } catch { /* Native event was incomplete. */ }
  }, []);
  useEffect(() => {
    const refresh = () => {
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
  const showSettings = settings && !session.active;
  useEffect(() => {
    if (!showSettings) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setSettings(false); return true; });
    return () => sub.remove();
  }, [showSettings]);

  const start = async () => {
    dispatch({ type: 'reset' });
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow the microphone to start talking.');
      if (Number(Platform.Version) >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      Audio.start(preset);
    } catch (error) { dispatch({ type: 'notice', message: error instanceof Error ? error.message : 'Could not start the session.' }); }
  };

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior="height">
    <StatusBar style="light" />
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      {session.active
        ? <Live session={session} />
        : showSettings
          ? <Settings config={config} onFamily={() => setConfig(Audio.configuration())} onBack={() => setSettings(false)} onSaved={() => { setConfig(Audio.configuration()); setSettings(false); dispatch({ type: 'reset' }); }} />
          : <Home session={session} preset={preset} onPreset={setPreset} configured={config.configured} family={{ language: familyLanguage(config.familyLanguage), voice: !!config.familyVoiceLanguage }} onStart={start} onSettings={() => setSettings(true)} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}

export default function App() { return <SafeAreaProvider><PhoneScreen /></SafeAreaProvider>; }

const display = 'Manrope';
const body = 'InstrumentSans';
const styles = StyleSheet.create({
  page: { flexGrow: 1 },
  inset: { paddingHorizontal: 24 },
  topBar: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 24, paddingRight: 12 },
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wordmark: { fontFamily: display, fontSize: 21, lineHeight: 28, fontWeight: '600', letterSpacing: -0.4, color: colors.strong },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  main: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 24, paddingTop: 48, paddingBottom: 40, gap: 16 },
  display: { fontFamily: display, fontSize: 44, lineHeight: 50, fontWeight: '500', letterSpacing: -1.1, color: colors.strong },
  headline: { fontFamily: display, fontSize: 34, lineHeight: 42, fontWeight: '500', letterSpacing: -0.7, color: colors.strong },
  lead: { fontFamily: body, fontSize: 19, lineHeight: 29, color: colors.secondary },
  body: { fontFamily: body, fontSize: 17, lineHeight: 26, color: colors.secondary },
  status: { fontFamily: body, fontSize: 17, lineHeight: 24, fontWeight: '600' },
  label: { fontFamily: body, fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.muted },
  caption: { fontFamily: body, fontSize: 13, lineHeight: 18, color: colors.muted, textAlign: 'center' },
  hint: { fontFamily: body, fontSize: 15, lineHeight: 22, color: colors.secondary, paddingTop: 12 },
  tabs: { flexDirection: 'row', gap: 28 },
  tab: { minHeight: 48, justifyContent: 'center', borderBottomWidth: 2 },
  tabText: { fontFamily: body, fontSize: 17, fontWeight: '500' },
  actions: { paddingHorizontal: 24, paddingTop: 24, gap: 16 },
  button: { minHeight: 64, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 },
  buttonText: { fontFamily: body, fontSize: 18, fontWeight: '600' },
  smallButton: { minHeight: 48, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center' },
  stopGlyph: { width: 14, height: 14, borderRadius: 3, backgroundColor: colors.text },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  liveText: { fontFamily: body, fontSize: 15, fontWeight: '500', color: colors.accent },
  quote: { gap: 8, padding: 20, borderRadius: 12, backgroundColor: colors.surface },
  quoteMeta: { fontFamily: body, fontSize: 14, lineHeight: 20, color: colors.muted },
  quoteText: { fontFamily: body, fontSize: 19, lineHeight: 28, color: colors.text },
  section: { fontFamily: body, fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.greenSoft, paddingBottom: 8 },
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 8 },
  rowTitle: { fontFamily: body, fontSize: 17, lineHeight: 24, color: colors.strong },
  rowDetail: { fontFamily: body, fontSize: 14, lineHeight: 20, color: colors.muted },
  rowState: { fontFamily: body, fontSize: 15, fontWeight: '600', minWidth: 72, textAlign: 'right' },
  fieldLabel: { fontFamily: body, fontSize: 14, lineHeight: 20, color: colors.secondary },
  input: { minHeight: 56, borderRadius: 8, borderWidth: 1, paddingHorizontal: 16, fontFamily: body, fontSize: 16, color: colors.text },
  saveRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16 },
});
