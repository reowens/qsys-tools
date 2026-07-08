// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// icon-pad.m — draw a source image scaled + centered on a transparent square canvas.
//
// Windows app icons fill the whole square; macOS icons sit inside the tile with a transparent
// margin (~80% content). sips can resize but can't pad with transparency, so the icon pipeline
// uses this tiny Cocoa helper to give the extracted Q-SYS icon a proper macOS-style margin.
//
//   icon-pad <src.png> <out.png> <size> <scale>
//     size  = output edge in px (e.g. 256)
//     scale = artwork fraction of the tile (e.g. 0.82 → ~9% margin each side)
//
// Build:  clang -arch x86_64 -arch arm64 -framework Cocoa -fobjc-arc \
//               -mmacosx-version-min=11.0 -o icon-pad icon-pad.m

#import <Cocoa/Cocoa.h>

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc < 5) {
            fprintf(stderr, "usage: icon-pad <src.png> <out.png> <size> <scale>\n");
            return 2;
        }
        NSString *in = [NSString stringWithUTF8String:argv[1]];
        NSString *out = [NSString stringWithUTF8String:argv[2]];
        int size = atoi(argv[3]);
        double scale = atof(argv[4]);
        if (size <= 0 || scale <= 0 || scale > 1) return 2;

        NSImage *src = [[NSImage alloc] initWithContentsOfFile:in];
        if (!src) { fprintf(stderr, "icon-pad: cannot read %s\n", argv[1]); return 3; }

        NSBitmapImageRep *rep =
            [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                    pixelsWide:size
                                                    pixelsHigh:size
                                                 bitsPerSample:8
                                               samplesPerPixel:4
                                                      hasAlpha:YES
                                                      isPlanar:NO
                                                colorSpaceName:NSCalibratedRGBColorSpace
                                                   bytesPerRow:0
                                                  bitsPerPixel:0];
        if (!rep) return 4;

        NSGraphicsContext *ctx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:ctx];
        [[NSColor clearColor] set];
        NSRectFill(NSMakeRect(0, 0, size, size));

        double inner = size * scale;
        double off = (size - inner) / 2.0;
        [src drawInRect:NSMakeRect(off, off, inner, inner)
               fromRect:NSZeroRect
              operation:NSCompositingOperationSourceOver
               fraction:1.0
         respectFlipped:YES
                  hints:@{ NSImageHintInterpolation : @(NSImageInterpolationHigh) }];

        [ctx flushGraphics];
        [NSGraphicsContext restoreGraphicsState];

        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:out atomically:YES]) {
            fprintf(stderr, "icon-pad: cannot write %s\n", argv[2]);
            return 5;
        }
        return 0;
    }
}
