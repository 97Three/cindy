import Foundation

// Mirrors `UsageWidgetState` / `MobileUsageWidgetSnapshot` in the app (TypeScript). The app
// writes it into the shared App Group; this extension only reads and renders.

struct WidgetSource: Decodable, Identifiable {
  let id: String
  let kind: String
  let name: String
  let logo: String?
  let monogram: String
  let value: String?
  let unit: String?
  let label: String?
  let level: String
  let fill: Double
  let reserve: Bool
  let emphasized: Bool
  let when: String
  let resetsAtMs: Double?
}

struct WidgetDay: Decodable {
  let money: [Double]
  let paid: Double
  let tokens: [Double]

  var total: Double { money.reduce(0, +) }
  var totalTokens: Double { tokens.reduce(0, +) }
}

struct WidgetUsage: Decodable {
  let scope: String
  let days: [String]
  let daily: [WidgetDay]
}

struct WidgetSnapshot: Decodable {
  let version: Int
  let generatedAtMs: Double
  let updatedAtMs: Double?
  let locale: String
  let moneySymbol: String
  let sources: [WidgetSource]
  let usage: WidgetUsage
  let strings: [String: String]
}

enum WidgetState: Decodable {
  case snapshot(receivedAtMs: Double, deviceName: String, snapshot: WidgetSnapshot)
  case updateDesktop
  case empty

  private enum Keys: String, CodingKey { case kind, receivedAtMs, deviceName, snapshot }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Keys.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "snapshot":
      self = .snapshot(
        receivedAtMs: try container.decode(Double.self, forKey: .receivedAtMs),
        deviceName: try container.decode(String.self, forKey: .deviceName),
        snapshot: try container.decode(WidgetSnapshot.self, forKey: .snapshot)
      )
    case "update-desktop":
      self = .updateDesktop
    default:
      self = .empty
    }
  }

  /// Same file name as `CindyUsageWidgetsModule` in the app.
  static func load() -> WidgetState {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "CindyAppGroupId") as? String,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let data = try? Data(contentsOf: container.appendingPathComponent("usage-widget-snapshot.json")),
          let state = try? JSONDecoder().decode(WidgetState.self, from: data)
    else { return .empty }
    return state
  }

  var snapshot: WidgetSnapshot? {
    if case .snapshot(_, _, let snapshot) = self { return snapshot }
    return nil
  }
}

/// Formatting shared by both widgets. Templates come from the computer's menu bar strings;
/// the few widget-only sentences live in `WidgetText`.
struct WidgetFormat {
  let snapshot: WidgetSnapshot?
  let now: Date

  var locale: Locale { Locale(identifier: snapshot?.locale ?? Locale.preferredLanguages.first ?? "en") }

  func s(_ key: String, _ values: [String: String] = [:]) -> String {
    var text = snapshot?.strings[key] ?? WidgetText.fallback(key, locale: locale)
    for (name, value) in values { text = text.replacingOccurrences(of: "{{\(name)}}", with: value) }
    return text
  }

  func money(_ value: Double) -> String {
    let symbol = snapshot?.moneySymbol ?? "$"
    if value >= 10_000 { return symbol + String(format: "%.1fk", value / 1000) }
    if value >= 100 {
      let formatter = NumberFormatter()
      formatter.numberStyle = .decimal
      formatter.locale = Locale(identifier: "en_US")
      formatter.maximumFractionDigits = 0
      return symbol + (formatter.string(from: NSNumber(value: value.rounded())) ?? String(Int(value)))
    }
    return symbol + String(format: "%.2f", value)
  }

  func tokens(_ value: Double) -> String {
    let millions = value / 1_000_000
    if millions >= 1000 { return String(format: "%.1fB", millions / 1000) }
    if millions >= 1 { return "\(Int(millions.rounded()))M" }
    if value >= 1000 { return "\(Int((value / 1000).rounded()))K" }
    return "\(Int(max(0, value).rounded()))"
  }

  /// "5天9时" from the reset time, so the countdown stays right between refreshes.
  /// `coarse` keeps only the largest unit for the narrow small widget.
  func when(_ source: WidgetSource, coarse: Bool = false) -> String {
    guard let resetsAtMs = source.resetsAtMs else { return source.when }
    let ms = resetsAtMs - now.timeIntervalSince1970 * 1000
    if ms <= 0 { return WidgetText.text("reset", locale: locale) }
    let minutes = max(1, Int(ms / 60_000))
    let d = minutes / 1440, h = (minutes % 1440) / 60, m = minutes % 60
    if d > 0 { return h > 0 && !coarse ? s("durationShort.daysHours", ["d": "\(d)", "h": "\(h)"]) : s("durationShort.days", ["d": "\(d)"]) }
    if h > 0 { return m > 0 && !coarse ? s("durationShort.hoursMinutes", ["h": "\(h)", "m": "\(m)"]) : s("durationShort.hours", ["h": "\(h)"]) }
    return s("durationShort.minutes", ["m": "\(m)"])
  }

  /// Age of the quota readings; nil when fresh enough not to mention.
  func staleLabel(minimumHours: Double) -> String? {
    guard let updated = snapshot?.updatedAtMs ?? snapshot?.generatedAtMs else { return nil }
    let seconds = max(0, now.timeIntervalSince1970 - updated / 1000)
    guard seconds >= minimumHours * 3600 else { return nil }
    return updatedLabel(seconds)
  }

  func updatedLabel() -> String {
    guard let updated = snapshot?.updatedAtMs ?? snapshot?.generatedAtMs else { return "" }
    return updatedLabel(max(0, now.timeIntervalSince1970 - updated / 1000))
  }

  private func updatedLabel(_ seconds: Double) -> String {
    if seconds < 60 { return s("updatedJustNow") }
    if seconds < 3600 { return s("updatedMinutes", ["n": "\(Int(seconds / 60))"]) }
    if seconds < 86400 { return s("updatedHours", ["n": "\(Int(seconds / 3600))"]) }
    return s("updatedDays", ["n": "\(Int(seconds / 86400))"])
  }

  func date(_ iso: String) -> Date {
    let parts = iso.split(separator: "-").compactMap { Int($0) }
    var components = DateComponents()
    if parts.count == 3 { components.year = parts[0]; components.month = parts[1]; components.day = parts[2]; components.hour = 12 }
    return Calendar.current.date(from: components) ?? now
  }

  func monthDay(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
    return formatter.string(from: date(iso))
  }

  func weekdayNarrow(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("EEEEE")
    return formatter.string(from: date(iso))
  }

  func weekday(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("EEE")
    return formatter.string(from: date(iso))
  }
}

/// Sentences the computer does not send: empty states and the widget gallery.
enum WidgetText {
  private static let table: [String: [String: String]] = [
    "zh-Hans": [
      "quotaName": "订阅余量", "quotaDescription": "每个订阅还剩多少、什么时候回满。",
      "usageName": "每日用量", "usageDescription": "今天用了多少，和最近每天的走势。",
      "emptyTitle": "还没读到余量", "emptyBody": "打开 Cindy 连上一台电脑，这里就会显示每个订阅还剩多少、什么时候回满。",
      "emptyUsageTitle": "还没读到用量", "emptyUsageBody": "打开 Cindy 连上一台电脑，这里就会显示每天的用量。",
      "updateTitle": "电脑上的 Cindy 需要更新", "updateBody": "更新后这里会显示余量和每天的用量。",
      "noSources": "还没有带余量的账号", "valueBasis": "订阅等值", "valueBasisLong": "订阅等值估算", "reset": "已重置",
      "todayNone": "今天还没有用量",
    ],
    "zh-Hant": [
      "quotaName": "訂閱餘量", "quotaDescription": "每個訂閱還剩多少、什麼時候回滿。",
      "usageName": "每日用量", "usageDescription": "今天用了多少，和最近每天的走勢。",
      "emptyTitle": "還沒讀到餘量", "emptyBody": "打開 Cindy 連上一台電腦，這裡就會顯示每個訂閱還剩多少、什麼時候回滿。",
      "emptyUsageTitle": "還沒讀到用量", "emptyUsageBody": "打開 Cindy 連上一台電腦，這裡就會顯示每天的用量。",
      "updateTitle": "電腦上的 Cindy 需要更新", "updateBody": "更新後這裡會顯示餘量和每天的用量。",
      "noSources": "還沒有帶餘量的帳號", "valueBasis": "訂閱等值", "valueBasisLong": "訂閱等值估算", "reset": "已重置",
      "todayNone": "今天還沒有用量",
    ],
    "en": [
      "quotaName": "Subscription quota", "quotaDescription": "What each subscription has left and when it refills.",
      "usageName": "Daily usage", "usageDescription": "Today's usage and the trend of recent days.",
      "emptyTitle": "No quota yet", "emptyBody": "Open Cindy and connect a computer to see what each subscription has left.",
      "emptyUsageTitle": "No usage yet", "emptyUsageBody": "Open Cindy and connect a computer to see your daily usage.",
      "updateTitle": "Update Cindy on your computer", "updateBody": "Quota and daily usage appear here after the update.",
      "noSources": "No accounts with quota yet", "valueBasis": "Subscription value", "valueBasisLong": "Subscription value estimate",
      "reset": "Reset", "todayNone": "No usage today",
      "today": "Today", "dailyAverage": "Daily avg", "paid": "Paid", "tokenUnit": "tokens",
      "monthScopeAll": "Last 30 days · All devices", "monthScopeLocal": "Last 30 days · This computer",
      "scopeAll": "All devices", "scopeLocal": "This computer",
      "harness.claude-code": "Claude Code", "harness.codex": "Codex", "harness.pi": "Pi",
      "updatedJustNow": "Updated just now", "updatedMinutes": "Updated {{n}}m ago", "updatedHours": "Updated {{n}}h ago",
      "updatedDays": "Updated {{n}}d ago",
      "durationShort.daysHours": "{{d}}d {{h}}h", "durationShort.days": "{{d}}d", "durationShort.hoursMinutes": "{{h}}h {{m}}m",
      "durationShort.hours": "{{h}}h", "durationShort.minutes": "{{m}}m",
    ],
  ]

  private static func language(_ locale: Locale) -> String {
    let id = locale.identifier
    if id.hasPrefix("zh") { return id.contains("Hant") || id.contains("TW") || id.contains("HK") ? "zh-Hant" : "zh-Hans" }
    return "en"
  }

  static func text(_ key: String, locale: Locale = Locale(identifier: Locale.preferredLanguages.first ?? "en")) -> String {
    table[language(locale)]?[key] ?? table["en"]?[key] ?? key
  }

  /// Strings normally sent by the computer, for snapshots that lack them and for placeholders.
  static func fallback(_ key: String, locale: Locale) -> String {
    if let value = table[language(locale)]?[key] { return value }
    return table["en"]?[key] ?? key
  }
}
