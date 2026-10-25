// mac-icon.swift: render the macOS app icon from the master art, on Apple's icon grid.
//
// macOS draws app icons as a continuous-corner squircle on a 1024px canvas, with the body at 824px
// and a soft shadow beneath. The master art (resources/new-icon.png) carries its own rounded frame,
// which does not match that shape, so this crops inside the frame, fills Apple's squircle with the art,
// and strokes a metal gold rim along the new edge. The ring and star are untouched.
//
// usage: swift scripts/mac-icon.swift <master.png> <out-1024.png>

import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count == 3, let master = NSImage(contentsOfFile: args[1]),
      let art = master.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: swift mac-icon.swift <master.png> <out.png>\n".data(using: .utf8)!)
  exit(1)
}

let canvas = 1024.0
let body = CGRect(x: 100, y: 100, width: 824, height: 824)

/// Apple's icon shape is a continuous-corner squircle; a superellipse with exponent 4 matches the
/// current macOS shape, set beside Calendar at Dock size.
func squircle(in rect: CGRect, exponent n: Double = 4, steps: Int = 720) -> CGPath {
  let path = CGMutablePath()
  let a = rect.width / 2, b = rect.height / 2
  for i in 0...steps {
    let t = Double(i) / Double(steps) * 2 * Double.pi
    let c = cos(t), s = sin(t)
    let x = rect.midX + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
    let y = rect.midY + b * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: Int(canvas), height: Int(canvas), bitsPerComponent: 8, bytesPerRow: 0,
                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }

let shape = squircle(in: body)

// Shadow, from Apple's macOS icon template: a soft drop beneath the body.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 22, color: CGColor(gray: 0, alpha: 0.35))
ctx.addPath(shape)
ctx.setFillColor(CGColor(srgbRed: 0.008, green: 0.13, blue: 0.28, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// The art, cropped inside the master's own gold frame, filling the squircle.
let side = Double(art.width)
let inset = side * 130 / 1254
let crop = CGRect(x: inset, y: inset, width: side - 2 * inset, height: side - 2 * inset)
if let inner = art.cropping(to: crop) {
  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  ctx.interpolationQuality = .high
  ctx.draw(inner, in: body)
  ctx.restoreGState()
}

// The gold rim: a metal gradient, light at the top to dark at the bottom, inside the edge.
let rimWidth = 30.0
let rim = shape.copy(strokingWithWidth: rimWidth, lineCap: .round, lineJoin: .round, miterLimit: 10)
let gold = CGGradient(colorsSpace: space, colors: [
  CGColor(srgbRed: 1.00, green: 0.93, blue: 0.66, alpha: 1),
  CGColor(srgbRed: 0.95, green: 0.79, blue: 0.30, alpha: 1),
  CGColor(srgbRed: 0.72, green: 0.56, blue: 0.17, alpha: 1),
  CGColor(srgbRed: 0.98, green: 0.86, blue: 0.48, alpha: 1),
] as CFArray, locations: [0, 0.35, 0.75, 1])!
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
ctx.addPath(rim)
ctx.clip()
ctx.drawLinearGradient(gold, start: CGPoint(x: body.midX, y: body.maxY), end: CGPoint(x: body.midX, y: body.minY), options: [])
ctx.restoreGState()

// A hairline of light just inside the rim, so the edge reads as bevelled metal rather than paint.
let inner = squircle(in: body.insetBy(dx: rimWidth / 2 + 1, dy: rimWidth / 2 + 1))
ctx.saveGState()
ctx.addPath(inner)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 0.95, blue: 0.75, alpha: 0.35))
ctx.setLineWidth(2)
ctx.strokePath()
ctx.restoreGState()

guard let image = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: image)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("wrote \(args[2])")
