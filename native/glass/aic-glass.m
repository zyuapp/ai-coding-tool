/**
 * Puts Liquid Glass under a window's web contents, where AppKit has glass, in place of the vibrancy
 * blur Electron put there. The glass is the system's own, so it is as clear or as tinted as the
 * person has set it.
 */
#import <AppKit/AppKit.h>
#include <node_api.h>

static NSString *const kGlassIdentifier = @"aic-window-glass";
static NSString *const kRegionIdentifier = @"aic-glass-region";

/** Looked up by name, so the addon builds against an SDK older than the class. */
static Class GlassClass(void) {
  return NSClassFromString(@"NSGlassEffectView");
}

/** The content view of the window that owns the handle `BrowserWindow.getNativeWindowHandle()` returns. */
static NSView *RootView(napi_env env, napi_value handle) {
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void *)) return nil;
  return ((__bridge NSView *)(*(void **)data)).window.contentView;
}

static napi_value Available(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, GlassClass() != nil, &result);
  return result;
}

/** Lays one sheet of glass under the whole window. */
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value attached;
  napi_get_boolean(env, false, &attached);
  Class glass = GlassClass();
  if (!glass || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return attached;
  NSView *root = RootView(env, argv[0]);
  if (!root) return attached;

  for (NSView *view in [root.subviews copy]) {
    if ([view.identifier isEqualToString:kGlassIdentifier]) [view removeFromSuperview];
    /** The blur would sit behind the glass and frost what the glass is meant to show. */
    else if ([view isKindOfClass:[NSVisualEffectView class]]) view.hidden = YES;
  }
  NSView *view = [[glass alloc] initWithFrame:root.bounds];
  [view setValue:@0 forKey:@"cornerRadius"];
  view.identifier = kGlassIdentifier;
  view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [root addSubview:view positioned:NSWindowBelow relativeTo:nil];
  napi_get_boolean(env, true, &attached);
  return attached;
}

/**
 * Lays one pane of clear glass per region over the window's sheet and under its page, so what the
 * page draws there sits on a pane of its own. Takes a flat list of x, y from the top, width, height
 * and corner radius; panes are reused, so a region that moves is not rebuilt.
 */
static napi_value Regions(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value applied;
  napi_get_boolean(env, false, &applied);
  Class glass = GlassClass();
  if (!glass || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) return applied;
  NSView *root = RootView(env, argv[0]);
  uint32_t count = 0;
  if (!root || napi_get_array_length(env, argv[1], &count) != napi_ok) return applied;

  NSMutableArray<NSView *> *panes = [NSMutableArray array];
  NSView *sheet = nil;
  for (NSView *view in root.subviews) {
    if ([view.identifier isEqualToString:kRegionIdentifier]) [panes addObject:view];
    else if ([view.identifier isEqualToString:kGlassIdentifier]) sheet = view;
  }
  NSUInteger wanted = count / 5;
  while (panes.count > wanted) {
    [panes.lastObject removeFromSuperview];
    [panes removeLastObject];
  }
  for (NSUInteger index = 0; index < wanted; index++) {
    double values[5] = {0, 0, 0, 0, 0};
    for (uint32_t field = 0; field < 5; field++) {
      napi_value element;
      if (napi_get_element(env, argv[1], (uint32_t)index * 5 + field, &element) == napi_ok) napi_get_value_double(env, element, &values[field]);
    }
    CGFloat y = root.isFlipped ? values[1] : root.bounds.size.height - values[1] - values[3];
    NSRect frame = NSMakeRect(values[0], y, values[2], values[3]);
    NSView *pane = index < panes.count ? panes[index] : nil;
    if (!pane) {
      pane = [[glass alloc] initWithFrame:frame];
      [pane setValue:@1 forKey:@"style"];
      pane.identifier = kRegionIdentifier;
      if (sheet) [root addSubview:pane positioned:NSWindowAbove relativeTo:sheet];
      else [root addSubview:pane positioned:NSWindowBelow relativeTo:nil];
      [panes addObject:pane];
    }
    pane.frame = frame;
    [pane setValue:@(values[4]) forKey:@"cornerRadius"];
  }
  napi_get_boolean(env, true, &applied);
  return applied;
}

NAPI_MODULE_INIT() {
  napi_value available;
  napi_value attach;
  napi_value regions;
  napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, NULL, &available);
  napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, NULL, &attach);
  napi_create_function(env, "regions", NAPI_AUTO_LENGTH, Regions, NULL, &regions);
  napi_set_named_property(env, exports, "available", available);
  napi_set_named_property(env, exports, "attach", attach);
  napi_set_named_property(env, exports, "regions", regions);
  return exports;
}
