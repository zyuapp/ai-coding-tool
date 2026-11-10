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
  for (NSView *view in root.subviews) {
    if ([view.identifier isEqualToString:kRegionIdentifier]) [panes addObject:view];
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
      [root addSubview:pane positioned:NSWindowBelow relativeTo:nil];
      [panes addObject:pane];
    }
    pane.frame = frame;
    [pane setValue:@(values[4]) forKey:@"cornerRadius"];
    /** The clear style reads what is behind a pane through it, as the system's own floating bars do; the regular one frosts it. */
    NSNumber *style = values[5] > 0 ? @1 : @0;
    if (![[pane valueForKey:@"style"] isEqual:style]) [pane setValue:style forKey:@"style"];
  }
  napi_get_boolean(env, true, &applied);
  return applied;
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
  return exports;
}
