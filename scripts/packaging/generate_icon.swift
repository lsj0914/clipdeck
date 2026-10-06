// Original ClipDeck geometry; no third-party image or font is used.
import AppKit
import Foundation

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}
func rectangle(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat,
               _ radius: CGFloat, _ hex: UInt32) {
    color(hex).setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: 1024-y-h, width: w, height: h),
                 xRadius: radius, yRadius: radius).fill()
}
func line(_ points: [(CGFloat, CGFloat)], _ width: CGFloat, _ hex: UInt32, round: Bool = false) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: points[0].0, y: 1024-points[0].1))
    for point in points.dropFirst() { path.line(to: NSPoint(x: point.0, y: 1024-point.1)) }
    path.lineWidth = width
    if round { path.lineCapStyle = .round }
    color(hex).setStroke()
    path.stroke()
}

if CommandLine.arguments.count != 2 {
    fputs("Usage: generate_icon.swift NEW_OUTPUT_DIRECTORY\n", stderr)
    exit(1)
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fm = FileManager.default
if fm.fileExists(atPath: root.path) {
    fputs("Choose a new output directory\n", stderr)
    exit(1)
}
try fm.createDirectory(at: root, withIntermediateDirectories: true)
let iconset = root.appendingPathComponent("ClipDeck.iconset", isDirectory: true)
try fm.createDirectory(at: iconset, withIntermediateDirectories: false)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(size) / 1024)
    transform.concat()
    rectangle(88, 88, 848, 848, 196, 0x232526)
    let border = NSBezierPath(roundedRect: NSRect(x: 89, y: 89, width: 846, height: 846), xRadius: 195, yRadius: 195)
    color(0x343637).setStroke(); border.lineWidth = 2; border.stroke()
    rectangle(240, 228, 432, 512, 48, 0x4d5050)
    rectangle(268, 256, 432, 512, 48, 0x878982)
    rectangle(296, 284, 432, 512, 48, 0xe4e0d6)
    line([(586, 284), (449, 796)], 72, 0x232526)
    line([(586, 284), (449, 796)], 48, 0xd4a345)
    for points: [(CGFloat, CGFloat)] in [[(349,389),(438,389)],[(349,433),(420,433)],[(589,647),(675,647)],[(578,691),(675,691)]] {
        line(points, 12, 0xa8a99f, round: true)
    }
    NSGraphicsContext.restoreGraphicsState()
    let png = bitmap.representation(using: .png, properties: [:])!
    if size == 1024 { try png.write(to: root.appendingPathComponent("clipdeck-icon.png")) }
    for base in [16,32,128,256,512] {
        if size == base { try png.write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png")) }
        if size == base * 2 { try png.write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png")) }
    }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("ClipDeck.icns").path]
try process.run()
process.waitUntilExit()
if process.terminationStatus != 0 { exit(process.terminationStatus) }
print(root.appendingPathComponent("ClipDeck.icns").path)
