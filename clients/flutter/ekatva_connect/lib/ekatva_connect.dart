/// A Flutter app's link to ekatva, and through it to its own half on the
/// laptop (or, once you allow it, to another app on either device).
///
/// ```dart
/// final ekatva = Ekatva({'id': 'notes', 'name': 'Notes', 'version': '1',
///   'methods': [{'name': 'open', 'why': 'Open a note'}]});
/// ekatva.status.addListener(...);            // "unlinked": show "Link with ekatva"
/// ekatva.link();                             // that button: ekatva asks, once
/// await ekatva.call('add', {'text': 'milk'}); // Notes on the laptop
/// ekatva.on('open', (input, from, files) async => ...);
/// ```
///
/// Without ekatva the status is "not-installed" and calls fail in words:
/// keep the app working alone.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Answers a call: its input, who called ({key, name, app?}), and its files
/// ({name, size, mime, uri}: this app's own copies).
typedef EkatvaHandler = FutureOr<Object?> Function(
    Object? input, Map<String, dynamic> from, List<Map<String, dynamic>> files);
typedef EkatvaEventHandler = void Function(Object? data, Map<String, dynamic> from, int at);

class EkatvaException implements Exception {
  EkatvaException(this.message);
  final String message;
  @override
  String toString() => message;
}

class Ekatva {
  Ekatva(this.manifest) {
    unawaited(_start());
  }

  static const _methods = MethodChannel('ekatva_connect');
  static const _events = EventChannel('ekatva_connect/events');
  static const _call = 2, _emit = 3, _reply = 4, _status = 5;
  static const _known = {'waiting', 'unlinked', 'pending', 'allowed', 'denied', 'refused'};

  final Map<String, dynamic> manifest;

  /// not-installed, connecting, waiting, unlinked, pending, allowed, denied,
  /// refused or disconnected (as in @ekatva/connect).
  final ValueNotifier<String> status = ValueNotifier('connecting');

  /// Why, in words, when it isn't "allowed".
  String? why;

  final _handlers = <String, EkatvaHandler>{};
  final _eventHandlers = <String, EkatvaEventHandler>{};
  final _pending = <String, Completer<Object?>>{};
  StreamSubscription<dynamic>? _sub;
  int _ids = 0;

  Future<void> _start() async {
    _sub = _events.receiveBroadcastStream().listen((e) {
      final m = Map<String, dynamic>.from(e as Map);
      _onEvent(m['event'] as String, m['data'] as String);
    });
    await _connect(manifest);
  }

  Future<void> _connect(Map<String, dynamic> hello) async {
    try {
      if (await _methods.invokeMethod<bool>('installed') != true) {
        return _set('not-installed', "ekatva isn't on this phone");
      }
      if (await _methods.invokeMethod<bool>('connect', {'manifest': jsonEncode(hello)}) != true) {
        _set('not-installed', "can't reach ekatva");
      }
    } on MissingPluginException {
      _set('not-installed', 'ekatva is for Android');
    } on PlatformException catch (e) {
      _set('not-installed', e.message);
    }
  }

  /// Asks to link with ekatva (your "Link with ekatva" button).
  Future<void> link() => _connect({...manifest, 'link': true});

  void _set(String s, [String? w]) {
    why = w;
    status.value = s;
    if (s != 'allowed') {
      for (final c in _pending.values.toList()) {
        c.completeError(EkatvaException(w ?? s));
      }
      _pending.clear();
    }
  }

  void _onEvent(String event, String data) {
    if (event == 'disconnect') return _set('disconnected', data);
    final m = jsonDecode(data) as Map<String, dynamic>;
    switch (event) {
      case 'welcome':
        final s = '${m['status']}';
        _set(s == 'replaced' ? 'disconnected' : (_known.contains(s) ? s : 'refused'), m['why'] as String?);
      case 'result':
        final c = _pending.remove('${m['id']}');
        if (m['ok'] == true) {
          c?.complete(m['result']);
        } else {
          c?.completeError(EkatvaException('${m['error'] ?? 'failed'}'));
        }
      case 'incoming':
        unawaited(_incoming(m));
    }
  }

  Future<void> _incoming(Map<String, dynamic> m) async {
    final from = Map<String, dynamic>.from((m['from'] as Map?) ?? {'key': '', 'name': 'the laptop'});
    if (m['kind'] == 'event') {
      _eventHandlers[m['name']]?.call(m['data'], from, (m['at'] as num?)?.toInt() ?? 0);
      return;
    }
    if (m['kind'] != 'call') return;
    Map<String, dynamic> reply;
    try {
      final h = _handlers[m['method']];
      if (h == null) throw EkatvaException('${manifest['name']} doesn\'t answer "${m['method']}" yet');
      final files = ((m['files'] as List?) ?? []).map((f) => Map<String, dynamic>.from(f as Map)).toList();
      reply = {'id': m['id'], 'ok': true, 'result': await h(m['input'], from, files)};
    } catch (e) {
      reply = {'id': m['id'], 'ok': false, 'error': '$e'};
    }
    await _methods.invokeMethod<bool>('send', {'what': _reply, 'json': jsonEncode(reply)});
  }

  Future<Object?> _request(int what, Map<String, dynamic> body,
      {List<String> files = const [], Duration timeout = const Duration(seconds: 20)}) async {
    if (status.value != 'allowed') throw EkatvaException(why ?? status.value);
    final id = '${DateTime.now().microsecondsSinceEpoch}-${++_ids}';
    final c = Completer<Object?>();
    _pending[id] = c;
    final json = jsonEncode({'id': id, ...body});
    try {
      final sent = files.isEmpty
          ? await _methods.invokeMethod<bool>('send', {'what': what, 'json': json})
          : await _methods.invokeMethod<bool>('callWithFiles', {'json': json, 'files': files});
      if (sent != true) throw EkatvaException('not connected to ekatva');
      return await c.future.timeout(timeout, onTimeout: () => throw EkatvaException("ekatva didn't answer"));
    } on PlatformException catch (e) {
      throw EkatvaException(e.message ?? 'failed');
    } finally {
      _pending.remove(id);
    }
  }

  /// Calls this app's laptop half, or another app: [to] "laptop:APP" or
  /// "phone:APP" (you're asked once). [files]: paths or content URIs.
  Future<Object?> call(String method, [Object? input, String? to, List<String> files = const []]) => _request(
        _call,
        {'method': method, 'input': input, if (to != null) 'to': to},
        files: files,
        timeout: files.isNotEmpty ? const Duration(minutes: 10) : Duration(seconds: to == null ? 20 : 90),
      );

  /// An event for the laptop half; [keep] seconds holds it until that app runs.
  Future<void> emit(String name, [Object? data, int keep = 0]) async {
    await _request(_emit, {'name': name, 'input': data, 'keep': keep});
  }

  /// Which laptop is linked, and this app's half there.
  Future<Object?> laptop() => _request(_status, {});

  void on(String method, EkatvaHandler handler) => _handlers[method] = handler;
  void onEvent(String name, EkatvaEventHandler handler) => _eventHandlers[name] = handler;

  Future<void> close() async {
    await _sub?.cancel();
    _set('disconnected', 'closed');
    await _methods.invokeMethod<void>('disconnect');
  }
}
