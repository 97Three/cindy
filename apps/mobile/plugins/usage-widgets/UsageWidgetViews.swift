import SwiftUI
import WidgetKit

/// Stacking order bottom to top, same as the Mac chart: Codex, Claude Code, Pi.
private let harnessStack = [1, 0, 2]
private let harnessKeys = ["claude-code", "codex", "pi"]

/// Monotone cubic through the points (no overshoot), like Swift Charts' `.monotone`.
func monotonePath(_ points: [CGPoint], into path: inout Path, move: Bool) {
  let n = points.count
  guard n > 1 else { return }
  var dx = [CGFloat](repeating: 0, count: n - 1), m = dx
  for i in 0..<(n - 1) {
    dx[i] = points[i + 1].x - points[i].x
    m[i] = dx[i] == 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i]
  }
  var t = [CGFloat](repeating: 0, count: n)
  t[0] = m[0]; t[n - 1] = m[n - 2]
  if n > 2 { for i in 1..<(n - 1) { t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2 } }
  for i in 0..<(n - 1) {
    if m[i] == 0 { t[i] = 0; t[i + 1] = 0; continue }
    let a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b
    if s > 9 { let k = 3 / s.squareRoot(); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i] }
  }
  if move { path.move(to: points[0]) } else { path.addLine(to: points[0]) }
  for i in 0..<(n - 1) {
    let h = dx[i] / 3
    path.addCurve(to: points[i + 1],
                  control1: CGPoint(x: points[i].x + h, y: points[i].y + h * t[i]),
                  control2: CGPoint(x: points[i + 1].x - h, y: points[i + 1].y - h * t[i + 1]))
  }
}

/// The month card's stacked area with the total line.
struct StackedAreaChart: View {
  let daily: [WidgetDay]
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let n = daily.count
      if n > 1 {
        let layers = cumulative()
        let maxTotal = max(layers.last?.max() ?? 0, 0.0001) * 1.08
        let point = { (layer: [Double], i: Int) in
          CGPoint(x: CGFloat(i) / CGFloat(n - 1) * size.width, y: size.height - CGFloat(layer[i] / maxTotal) * size.height)
        }
        ZStack {
          ForEach(0..<3, id: \.self) { k in
            let harness = harnessStack[k]
            Path { path in
              monotonePath((0..<n).map { point(layers[k + 1], $0) }, into: &path, move: true)
              monotonePath((0..<n).reversed().map { point(layers[k], $0) }, into: &path, move: false)
              path.closeSubpath()
            }
            .fill(fill(harness, height: size.height))
          }
          Path { path in monotonePath((0..<n).map { point(layers[3], $0) }, into: &path, move: true) }
            .stroke(WidgetPalette.ink.opacity(0.55), lineWidth: 1)
        }
      }
    }
  }

  private func fill(_ harness: Int, height: CGFloat) -> LinearGradient {
    let accented = renderingMode == .accented
    let color = accented ? Color.white.opacity(WidgetPalette.accentedOpacity(harness)) : WidgetPalette.harness(harness)
    return LinearGradient(colors: [color.opacity(0.95), color.opacity(0.55)], startPoint: .top, endPoint: .bottom)
  }

  private func cumulative() -> [[Double]] {
    var layers: [[Double]] = [Array(repeating: 0, count: daily.count)]
    for harness in harnessStack {
      let previous = layers.last!
      layers.append(daily.indices.map { previous[$0] + daily[$0].money[harness] })
    }
    return layers
  }
}

/// Daily stacked bars: today solid, earlier days at 60% (the usage-history emphasis rule).
struct DailyBars: View {
  let daily: [WidgetDay]
  let gap: CGFloat
  var average: Double? = nil
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let n = max(daily.count, 1)
      let barWidth = max(1, (size.width - gap * CGFloat(n - 1)) / CGFloat(n))
      let maxTotal = max(daily.map(\.total).max() ?? 0, average ?? 0, 0.0001) * 1.08
      let accented = renderingMode == .accented
      ZStack(alignment: .topLeading) {
        ForEach(daily.indices, id: \.self) { i in
          let day = daily[i]
          let x = CGFloat(i) * (barWidth + gap)
          let today = i == daily.count - 1
          if day.total <= 0 {
            RoundedRectangle(cornerRadius: 1).fill(WidgetPalette.ink4)
              .frame(width: barWidth, height: 2)
              .offset(x: x, y: size.height - 2)
          } else {
            let height = max(3, CGFloat(day.total / maxTotal) * size.height)
            VStack(spacing: 0) {
              ForEach(harnessStack.reversed(), id: \.self) { harness in
                let value = day.money[harness]
                if value > 0 {
                  Rectangle()
                    .fill(accented ? Color.white.opacity(WidgetPalette.accentedOpacity(harness)) : WidgetPalette.harness(harness))
                    .frame(height: CGFloat(value / day.total) * height)
                }
              }
            }
            .frame(width: barWidth, height: height)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: min(2, barWidth / 2), topTrailingRadius: min(2, barWidth / 2)))
            .opacity(today ? 1 : 0.6)
            .widgetAccentable(today)
            .offset(x: x, y: size.height - height)
          }
        }
        if let average, average > 0 {
          let y = size.height - CGFloat(average / maxTotal) * size.height
          Path { path in
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: size.width, y: y))
          }
          .stroke(WidgetPalette.ink2, style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
        }
      }
    }
  }
}

struct AverageLegend: View {
  let text: String
  var body: some View {
    HStack(spacing: 4) {
      Path { path in
        path.move(to: CGPoint(x: 0, y: 0.5))
        path.addLine(to: CGPoint(x: 12, y: 0.5))
      }
      .stroke(WidgetPalette.ink2, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
      .frame(width: 12, height: 1)
      Text(text).font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

struct HarnessDot: View {
  let harness: Int
  @Environment(\.widgetRenderingMode) private var renderingMode
  var body: some View {
    Circle()
      .fill(renderingMode == .accented ? Color.white.opacity(WidgetPalette.accentedOpacity(harness)) : WidgetPalette.harness(harness))
      .frame(width: 6, height: 6)
  }
}

struct UsageWidgetView: View {
  let state: WidgetState
  let now: Date
  @Environment(\.widgetFamily) private var family

  var body: some View {
    switch state {
    case .updateDesktop:
      EmptyStateView(title: WidgetText.text("updateTitle"), body_: WidgetText.text("updateBody")).padding(16)
    case .empty:
      EmptyStateView(title: WidgetText.text("emptyUsageTitle"), body_: WidgetText.text("emptyUsageBody")).padding(16)
    case .snapshot(_, _, let snapshot):
      if snapshot.usage.daily.isEmpty || snapshot.usage.days.isEmpty {
        let locale = Locale(identifier: snapshot.locale)
        EmptyStateView(title: WidgetText.text("emptyUsageTitle", locale: locale), body_: WidgetText.text("emptyUsageBody", locale: locale)).padding(16)
      } else {
        content(snapshot, format: WidgetFormat(snapshot: snapshot, now: now))
      }
    }
  }

  @ViewBuilder
  private func content(_ snapshot: WidgetSnapshot, format: WidgetFormat) -> some View {
    let daily = snapshot.usage.daily
    let days = snapshot.usage.days
    let today = daily[daily.count - 1]
    let average = daily.reduce(0) { $0 + $1.total } / Double(daily.count)
    let todayLabel = format.s("today")
    switch family {
    case .systemSmall:
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text(todayLabel)
          Spacer(minLength: 4)
          Text(format.monthDay(days[days.count - 1]))
        }
        .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
        Text(format.money(today.total))
          .font(WidgetNumFont.font(38))
          .foregroundStyle(today.total > 0 ? WidgetPalette.ink : WidgetPalette.ink3)
          .lineLimit(1).minimumScaleFactor(0.6)
          .padding(.top, 4)
        Text(today.total > 0 ? "\(format.tokens(today.totalTokens)) \(format.s("tokenUnit"))" : WidgetText.text("todayNone", locale: format.locale))
          .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        Spacer(minLength: 0)
        let week = Array(daily.suffix(7)), weekDays = Array(days.suffix(7))
        DailyBars(daily: week, gap: 8).frame(height: 36)
        HStack(spacing: 8) {
          ForEach(weekDays.indices, id: \.self) { i in
            Text(format.weekdayNarrow(weekDays[i]))
              .font(.system(size: 9.5, weight: i == weekDays.count - 1 ? .semibold : .regular))
              .foregroundStyle(i == weekDays.count - 1 ? WidgetPalette.ink : WidgetPalette.ink3)
              .frame(maxWidth: .infinity)
          }
        }
        .padding(.top, 4)
      }
      .padding(EdgeInsets(top: 15, leading: 16, bottom: 12, trailing: 16))
    case .systemLarge:
      let total = daily.reduce(0) { $0 + $1.total }
      let paid = daily.reduce(0) { $0 + $1.paid }
      let tokens = daily.reduce(0) { $0 + $1.totalTokens }
      let byHarness = (0..<3).map { h in daily.reduce(0) { $0 + $1.money[h] } }
      let lastDay = days[days.count - 1]
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("\(todayLabel) · \(format.monthDay(lastDay)) \(format.weekday(lastDay))")
          Spacer(minLength: 4)
          Text(format.s(snapshot.usage.scope == "local" ? "scopeLocal" : "scopeAll"))
        }
        .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        Text(format.money(today.total)).font(WidgetNumFont.font(46)).foregroundStyle(WidgetPalette.ink).padding(.top, 5)
        Text("\(WidgetText.text("valueBasisLong", locale: format.locale)) · \(format.tokens(today.totalTokens)) \(format.s("tokenUnit"))")
          .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).padding(.top, 3)
        Spacer(minLength: 6)
        AverageLegend(text: "\(format.s("dailyAverage")) \(format.money(average))").padding(.bottom, 5)
        DailyBars(daily: daily, gap: 3, average: average).frame(height: 108)
        HStack {
          Text(format.monthDay(days[0]))
          Spacer()
          Text(todayLabel)
        }
        .font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).padding(.top, 4)
        Rectangle().fill(WidgetPalette.line).frame(height: 0.5).padding(.top, 12).padding(.bottom, 10)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(format.s(snapshot.usage.scope == "local" ? "monthScopeLocal" : "monthScopeAll").components(separatedBy: " · ").first ?? "")
            .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
          Text(format.money(total)).font(WidgetNumFont.font(18)).foregroundStyle(WidgetPalette.ink)
          Spacer(minLength: 4)
          Text("\(format.s("paid")) \(format.money(paid)) · \(format.tokens(tokens)) \(format.s("tokenUnit"))")
            .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        }
        HarnessSplit(byHarness: byHarness, format: format).padding(.top, 9)
      }
      .padding(EdgeInsets(top: 16, leading: 16, bottom: 14, trailing: 16))
    default:
      VStack(spacing: 0) {
        HStack(alignment: .top, spacing: 14) {
          VStack(alignment: .leading, spacing: 0) {
            Text("\(todayLabel) · \(WidgetText.text("valueBasis", locale: format.locale))")
              .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
            Text(format.money(today.total)).font(WidgetNumFont.font(36))
              .foregroundStyle(today.total > 0 ? WidgetPalette.ink : WidgetPalette.ink3)
              .lineLimit(1).minimumScaleFactor(0.6).padding(.top, 4)
            Text("\(format.tokens(today.totalTokens)) \(format.s("tokenUnit"))")
              .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 4) {
              ForEach([0, 1, 2].filter { today.money[$0] > 0 }.sorted { today.money[$0] > today.money[$1] }, id: \.self) { h in
                HStack(spacing: 5) {
                  HarnessDot(harness: h)
                  Text(format.s("harness.\(harnessKeys[h])")).font(.system(size: 10.5)).foregroundStyle(WidgetPalette.ink2)
                    .lineLimit(1).minimumScaleFactor(0.85)
                  Spacer(minLength: 2)
                  Text(format.money(today.money[h])).font(WidgetNumFont.font(14)).foregroundStyle(WidgetPalette.ink)
                }
              }
            }
          }
          .frame(width: 116)
          VStack(spacing: 0) {
            Spacer(minLength: 0)
            AverageLegend(text: "\(format.s("dailyAverage")) \(format.money(average))").padding(.bottom, 5)
            DailyBars(daily: Array(daily.suffix(14)), gap: 4, average: average).frame(height: 80)
            HStack {
              Text(format.monthDay(days[max(0, days.count - 14)]))
              Spacer()
              Text(todayLabel)
            }
            .font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).padding(.top, 4)
          }
        }
      }
      .padding(EdgeInsets(top: 15, leading: 16, bottom: 12, trailing: 16))
    }
  }
}

/// One thin bar and three columns: name and share above, amount below (Mac usage page).
struct HarnessSplit: View {
  let byHarness: [Double]
  let format: WidgetFormat
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let total = max(byHarness.reduce(0, +), 0.0001)
    let order = [1, 0, 2]
    VStack(alignment: .leading, spacing: 8) {
      GeometryReader { geometry in
        let present = order.filter { byHarness[$0] > 0 }
        let available = geometry.size.width - CGFloat(max(0, present.count - 1)) * 2
        HStack(spacing: 2) {
          ForEach(present, id: \.self) { h in
            Capsule()
              .fill(renderingMode == .accented ? Color.white.opacity(WidgetPalette.accentedOpacity(h)) : WidgetPalette.harness(h))
              .frame(width: max(6, CGFloat(byHarness[h] / total) * available))
          }
        }
      }
      .frame(height: 4)
      HStack(alignment: .top, spacing: 0) {
        ForEach(order.indices, id: \.self) { position in
          let h = order[position]
          if position > 0 { Spacer(minLength: 10) }
          VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
              HarnessDot(harness: h)
              Text(format.s("harness.\(harnessKeys[h])")).foregroundStyle(WidgetPalette.ink2)
              Text("\(Int((byHarness[h] / total * 100).rounded()))%").foregroundStyle(WidgetPalette.ink3)
            }
            .font(.system(size: 10.5))
            .lineLimit(1)
            Text(format.money(byHarness[h])).font(WidgetNumFont.font(16)).foregroundStyle(WidgetPalette.ink).padding(.leading, 11)
          }
          .fixedSize()
        }
      }
    }
  }
}
