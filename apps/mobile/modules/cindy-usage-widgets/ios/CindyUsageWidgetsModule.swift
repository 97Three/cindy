import ExpoModulesCore
import WidgetKit

/// Writes the widget snapshot into the App Group the widget extension reads, then asks
/// WidgetKit to redraw. The app group is the one expo-sharing already provisions.
public final class CindyUsageWidgetsModule: Module {
  static let fileName = "usage-widget-snapshot.json"

  private func fileURL() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw POSIXError(.ENOENT) }
    return container.appendingPathComponent(Self.fileName)
  }

  public func definition() -> ModuleDefinition {
    Name("CindyUsageWidgets")

    /// Returns false when the App Group is unavailable (for example a build signed without it).
    Function("writeSnapshot") { (json: String) -> Bool in
      guard let url = try? self.fileURL() else { return false }
      do {
        try Data(json.utf8).write(to: url, options: .atomic)
      } catch {
        return false
      }
      WidgetCenter.shared.reloadAllTimelines()
      return true
    }

    Function("clearSnapshot") { () -> Void in
      guard let url = try? self.fileURL() else { return }
      try? FileManager.default.removeItem(at: url)
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
