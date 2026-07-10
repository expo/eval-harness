import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useApp } from '../src/AppContext';
import { getTitleAndPreview, formatTimestamp } from '../src/utils';

function PasswordGate() {
  const { attemptUnlock } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const onSubmit = () => {
    const result = attemptUnlock(password);
    if (!result.ok) {
      setError(result.error);
    } else {
      setError('');
    }
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

function NotesList() {
  const router = useRouter();
  const { notes, createNote, deleteNote } = useApp();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => {
      const { title } = getTitleAndPreview(n.body);
      return (
        title.toLowerCase().includes(q) ||
        (n.body && n.body.toLowerCase().includes(q))
      );
    });
  }, [notes, query]);

  const onCreate = async () => {
    const note = await createNote();
    router.push(`/note/${note.id}`);
  };

  const renderItem = ({ item }) => {
    const { title, preview } = getTitleAndPreview(item.body);
    return (
      <TouchableOpacity
        testID={`note-item-${item.id}`}
        style={styles.row}
        onPress={() => router.push(`/note/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.rowMain}>
          <Text
            style={styles.rowTitle}
            numberOfLines={1}
            testID={`text-note-title-${item.id}`}
          >
            {title}
          </Text>
          <Text
            style={styles.rowPreview}
            numberOfLines={1}
            ellipsizeMode="tail"
            testID={`text-note-preview-${item.id}`}
          >
            {preview}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowTimestamp} testID={`text-note-timestamp-${item.id}`}>
            {formatTimestamp(item.updatedAt)}
          </Text>
          <TouchableOpacity
            testID={`button-delete-note-${item.id}`}
            style={styles.rowDeleteButton}
            onPress={(e) => {
              e.stopPropagation && e.stopPropagation();
              confirmDelete(() => deleteNote(item.id));
            }}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.rowDeleteText} testID={`text-delete-note-label-${item.id}`}>
              Delete
            </Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} testID="screen-notes-list">
      <View style={styles.header}>
        <Text style={styles.headerTitle} testID="text-list-title">Notes</Text>
        <TouchableOpacity
          testID="button-new-note"
          style={styles.newButton}
          onPress={onCreate}
          activeOpacity={0.8}
        >
          <Text style={styles.newButtonText} testID="text-new-note-label">
            + New Note
          </Text>
        </TouchableOpacity>
      </View>
      <View style={styles.searchWrap}>
        <TextInput
          testID="input-search"
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search notes"
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      {filtered.length === 0 ? (
        <View style={styles.emptyWrap} testID="view-empty-state">
          <Text style={styles.emptyText} testID="text-empty-state">
            {notes.length === 0
              ? 'No notes yet. Tap "New Note" to create one.'
              : 'No notes match your search.'}
          </Text>
        </View>
      ) : (
        <FlatList
          testID="list-notes"
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
}

export default function Home() {
  const { unlocked, loaded } = useApp();
  if (!loaded) {
    return (
      <SafeAreaView style={styles.container} testID="screen-loading">
        <View style={styles.loadingWrap}>
          <Text style={styles.loadingText} testID="text-loading">Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }
  return unlocked ? <NotesList /> : <PasswordGate />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#666', fontSize: 16 },
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
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
  },
  newButton: {
    backgroundColor: '#111',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  newButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 15,
    color: '#111',
    backgroundColor: '#fafafa',
  },
  listContent: { paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#fff',
  },
  rowMain: { flex: 1, marginRight: 12 },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
    marginBottom: 4,
  },
  rowPreview: {
    fontSize: 13,
    color: '#666',
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  rowTimestamp: {
    fontSize: 12,
    color: '#999',
    marginBottom: 6,
  },
  rowDeleteButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  rowDeleteText: {
    fontSize: 12,
    color: '#c0392b',
    fontWeight: '600',
  },
  separator: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginLeft: 20,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
  },
});
