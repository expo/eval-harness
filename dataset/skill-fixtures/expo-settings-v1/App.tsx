import { useState } from "react";
import { Button, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { initialSettings, formatProfile } from "./src/actions";

export default function App() {
  const [name, setName] = useState(initialSettings.displayName);
  const [notifications, setNotifications] = useState(initialSettings.notifications);
  const [saved, setSaved] = useState(false);
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
    <Text style={{ fontSize: 28 }}>Settings</Text>
    <Text>{formatProfile(name)}</Text>
    <TextInput accessibilityLabel="Display name" value={name} onChangeText={setName} placeholder="Display name" />
    <View><Text>Notifications</Text><Switch accessibilityLabel="Notifications" value={notifications} onValueChange={setNotifications} /></View>
    <Button title="Save settings" onPress={() => setSaved(true)} />
    {saved && <Text accessibilityLiveRegion="polite">Settings saved</Text>}
  </ScrollView>;
}
