import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useApp } from '../../src/AppContext';

function confirmDelete(onConfirm) {
  const title = 'Delete note?';
  const message =
    'This will permanently delete this note. This action cannot be undone.';
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

function Editor({ note }) {
  const router = useRouter();
  const navigation = useNavigation();
  const { updateNote, deleteNote } = useApp();
  const [body, setBody] = useState(note.body);
  const bodyRef = useRef(note.body);
  const noteIdRef = useRef(note.id);
  const deletedRef = useRef(false);

  useEffect(() => {
    bodyRef.current = body;
  }, [body]);

  const flush = useCallback(async () => {
    if (deletedRef.current) return;
    await updateNote(noteIdRef.current, bodyRef.current);
  }, [updateNote]);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', () => {
      // Fire-and-forget; the AppContext will persist asynchronously.
      flush();
    });
    return unsub;
  }, [navigation, flush]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  const onBack = async () => {
    await flush();
    if (router.canGoBack && router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  };

  const onDelete = () => {
    confirmDelete(async () => {
      deletedRef.current = true;
      await deleteNote(noteIdRef.current);
      if (router.canGoBack && router.canGoBack()) {
        router.back();
      } else {
        router.replace('/');
      }
    });
  };

  return (
    <SafeAreaView style={styles.container} testID={`screen-note-${note.id}`}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <TouchableOpacity
            testID="button-back"
            style={styles.headerButton}
            onPress={onBack}
            activeOpacity={0.7}
          >
            <Text style={styles.headerButtonText} testID="text-back-label">
              ← Back
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="button-delete-note"
            style={[styles.headerButton, styles.deleteButton]}
            onPress={onDelete}
            activeOpacity={0.7}
          >
            <Text style={styles.deleteButtonText} testID="text-delete-label">
              Delete
            </Text>
          </TouchableOpacity>
        </View>
        <TextInput
          testID="input-note-body"
          style={styles.body}
          value={body}
          onChangeText={setBody}
          multiline
          autoFocus
          textAlignVertical="top"
          placeholder="Start typing…"
          placeholderTextColor="#aaa"
          scrollEnabled
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function NotFound() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.container} testID="screen-note-not-found">
      <View style={styles.notFoundWrap}>
        <Text style={styles.notFoundText} testID="text-note-not-found">
          Note not found.
        </Text>
        <TouchableOpacity
          testID="button-back-to-list"
          style={styles.primaryButton}
          onPress={() => router.replace('/')}
          activeOpacity={0.8}
        >
          <Text style={styles.primaryButtonText} testID="text-back-to-list-label">
            Back to Notes
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

export default function NoteScreen() {
  const { id } = useLocalSearchParams();
  const { unlocked, loaded, getNote, attemptUnlock } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container} testID="screen-note-loading">
        <View style={styles.notFoundWrap}>
          <Text style={styles.notFoundText} testID="text-loading">Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!unlocked) {
    const onSubmit = () => {
      const result = attemptUnlock(password);
      if (!result.ok) setError(result.error);
      else setError('');
    };
    return (
      <SafeAreaView style={styles.container} testID="screen-password-gate">
        <View style={styles.gateInner}>
          <Text style={styles.gateTitle} testID="text-gate-title">Notes</Text>
          <Text style={styles.gateSubtitle} testID="text-gate-subtitle">
            Enter password to unlock
          </Text>
          <TextInput
            testID="input-password"
            style={styles.input}
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              if (error) setError('');
            }}
            placeholder="Password"
            placeholderTextColor="#999"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
          {error ? (
            <Text style={styles.errorText} testID="text-password-error">
              {error}
            </Text>
          ) : null}
          <TouchableOpacity
            testID="button-unlock"
            style={styles.primaryButton}
            onPress={onSubmit}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryButtonText} testID="text-unlock-label">
              Unlock
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const note = getNote(String(id));
  if (!note) {
    return <NotFound />;
  }
  return <Editor key={note.id} note={note} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerButtonText: {
    fontSize: 16,
    color: '#111',
    fontWeight: '500',
  },
  deleteButton: {},
  deleteButtonText: {
    fontSize: 15,
    color: '#c0392b',
    fontWeight: '600',
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
    fontSize: 16,
    color: '#111',
    lineHeight: 22,
  },
  notFoundWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  notFoundText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 16,
  },
  gateInner: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  gateTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 8,
  },
  gateSubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    fontSize: 16,
    color: '#111',
    backgroundColor: '#fafafa',
    marginBottom: 8,
  },
  errorText: {
    color: '#c0392b',
    fontSize: 14,
    marginBottom: 8,
    marginTop: 4,
  },
  primaryButton: {
    backgroundColor: '#111',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
