# ekatva_connect

A Flutter app's link to [ekatva](https://github.com/Theyashsawarkar/ekatva), and through it to its other half on the laptop (Android; elsewhere it says "not-installed").

```yaml
dependencies:
  ekatva_connect:
    git:
      url: https://github.com/Theyashsawarkar/ekatva
      path: clients/flutter/ekatva_connect
```

See `lib/ekatva_connect.dart`. Its Android side is `clients/android/EkatvaClient.kt`, the same file (a test keeps them equal).
