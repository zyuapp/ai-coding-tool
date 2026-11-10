/**
 * Puts Liquid Glass under a window's web contents, where AppKit has glass, in place of the vibrancy
 * blur Electron put there. The glass is the system's own, so it is as clear or as tinted as the
 * person has set it.
 */
#import <AppKit/AppKit.h>
#include <node_api.h>

static NSString *const kGlassIdentifier = @"aic-window-glass";
static NSString *const kRegionIdentifier = @"aic-glass-region";

/**
 * The see-through layer takes the pointer only over its panes. AppKit sends a window that ignores the
 * mouse nothing to decide by, and a page cannot be told where the pointer is while its window is not
 * the key one, so the choice is made here, from where the pointer is and where the panes are.
 */
static __weak NSWindow *gLayer = nil;
static NSArray<NSValue *> *gLayerPanes = nil;
static id gPointerMonitor = nil;

static void FollowPointer(void) {
  NSWindow *layer = gLayer;
  /** A press that began on a pane keeps it until it ends, so a drag off its edge is not dropped. */
  if (!layer || NSEvent.pressedMouseButtons != 0) return;
  NSPoint at = [layer convertPointFromScreen:NSEvent.mouseLocation];
  BOOL over = NO;
  for (NSValue *pane in gLayerPanes) {
    if (NSPointInRect(at, pane.rectValue)) {
      over = YES;
      break;
    }
  }
  if (layer.ignoresMouseEvents == over) layer.ignoresMouseEvents = !over;
}

/** Looked up by name, so the addon builds against an SDK older than the class. */
static Class GlassClass(void) {
  return NSClassFromString(@"NSGlassEffectView");
}

static napi_value Available(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, GlassClass() != nil, &result);
  return result;
}

/** Takes the handle `BrowserWindow.getNativeWindowHandle()` returns, which holds the content view. */
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value attached;
  napi_get_boolean(env, false, &attached);
  Class glass = GlassClass();
  if (!glass || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return attached;
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return attached;
  NSView *handle = (__bridge NSView *)(*(void **)data);
  NSView *root = handle.window.contentView;
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
 * Lays one pane of glass per region under a see-through window's web contents, so what the page
 * draws there sits on glass that bends whatever is behind the window. Takes the window's handle and
 * a flat list of x, y from the top, width, height, corner radius and whether the pane is the clear
 * style; panes are reused, so a region that moves is not rebuilt.
 */
static napi_value Regions(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value applied;
  napi_get_boolean(env, false, &applied);
  Class glass = GlassClass();
  if (!glass || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) return applied;
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return applied;
  NSView *handle = (__bridge NSView *)(*(void **)data);
  NSView *root = handle.window.contentView;
  uint32_t count = 0;
  if (!root || napi_get_array_length(env, argv[1], &count) != napi_ok) return applied;

  NSMutableArray<NSView *> *panes = [NSMutableArray array];
  /** A window that is glass all over keeps its panes above that sheet, where they bend what shows through it. */
  NSView *sheet = nil;
  for (NSView *view in root.subviews) {
    if ([view.identifier isEqualToString:kRegionIdentifier]) [panes addObject:view];
    else if ([view.identifier isEqualToString:kGlassIdentifier]) sheet = view;
  }
  NSUInteger wanted = count / 6;
  while (panes.count > wanted) {
    [panes.lastObject removeFromSuperview];
    [panes removeLastObject];
  }
  for (NSUInteger index = 0; index < wanted; index++) {
    double values[6] = {0, 0, 0, 0, 0, 0};
    for (uint32_t field = 0; field < 6; field++) {
      napi_value element;
      if (napi_get_element(env, argv[1], (uint32_t)index * 6 + field, &element) == napi_ok) napi_get_value_double(env, element, &values[field]);
    }
    CGFloat y = root.isFlipped ? values[1] : root.bounds.size.height - values[1] - values[3];
    NSRect frame = NSMakeRect(values[0], y, values[2], values[3]);
    NSView *pane = index < panes.count ? panes[index] : nil;
    if (!pane) {
      pane = [[glass alloc] initWithFrame:frame];
      pane.identifier = kRegionIdentifier;
      if (sheet) [root addSubview:pane positioned:NSWindowAbove relativeTo:sheet];
      else [root addSubview:pane positioned:NSWindowBelow relativeTo:nil];
      [panes addObject:pane];
    }
    pane.frame = frame;
    [pane setValue:@(values[4]) forKey:@"cornerRadius"];
    [panes replaceObjectAtIndex:index withObject:pane];
    /** The clear style reads what is behind a pane through it, as the system's own floating bars do; the regular one frosts it. */
    NSNumber *style = values[5] > 0 ? @1 : @0;
    if (![[pane valueForKey:@"style"] isEqual:style]) [pane setValue:style forKey:@"style"];
  }
  if (handle.window == gLayer) {
    NSMutableArray<NSValue *> *rects = [NSMutableArray array];
    for (NSView *pane in panes) [rects addObject:[NSValue valueWithRect:[root convertRect:pane.frame toView:nil]]];
    gLayerPanes = rects;
    FollowPointer();
  }
  napi_get_boolean(env, true, &applied);
  return applied;
}

/** Makes a window the see-through layer: it lets the pointer through everywhere but over its panes. */
static napi_value Track(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value tracked;
  napi_get_boolean(env, false, &tracked);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return tracked;
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return tracked;
  NSWindow *window = ((__bridge NSView *)(*(void **)data)).window;
  if (!window) return tracked;
  gLayer = window;
  gLayerPanes = @[];
  window.ignoresMouseEvents = YES;
  window.acceptsMouseMovedEvents = YES;
  window.parentWindow.acceptsMouseMovedEvents = YES;
  if (!gPointerMonitor) {
    NSEventMask moves = NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp | NSEventMaskMouseEntered | NSEventMaskMouseExited | NSEventMaskScrollWheel;
    gPointerMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:moves handler:^NSEvent *(NSEvent *event) {
      FollowPointer();
      return event;
    }];
  }
  napi_get_boolean(env, true, &tracked);
  return tracked;
}

/**
 * Whether a window draws as the one in use. AppKit frosts clear glass in any window that is not the
 * key one, and has no public way to say a panel is part of the window under it, so this asks the
 * window itself where it still answers.
 */
static napi_value Active(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value applied;
  napi_get_boolean(env, false, &applied);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) return applied;
  void *data = NULL;
  size_t length = 0;
  bool active = false;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *) || napi_get_value_bool(env, argv[1], &active) != napi_ok) return applied;
  NSWindow *window = ((__bridge NSView *)(*(void **)data)).window;
  SEL force = NSSelectorFromString(@"_setForceMainAppearance:");
  if (![window respondsToSelector:force]) return applied;
  ((void (*)(id, SEL, BOOL))[window methodForSelector:force])(window, force, active ? YES : NO);
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
  napi_value active;
  napi_create_function(env, "active", NAPI_AUTO_LENGTH, Active, NULL, &active);
  napi_set_named_property(env, exports, "active", active);
  napi_value track;
  napi_create_function(env, "track", NAPI_AUTO_LENGTH, Track, NULL, &track);
  napi_set_named_property(env, exports, "track", track);
  return exports;
}
