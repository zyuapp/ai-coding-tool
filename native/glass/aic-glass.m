/**
 * Puts Liquid Glass under a window's web contents, where AppKit has glass, in place of the vibrancy
 * blur Electron put there. The glass is the system's own, so it is as clear or as tinted as the
 * person has set it.
 */
#import <AppKit/AppKit.h>
#include <node_api.h>

static NSString *const kGlassIdentifier = @"aic-window-glass";

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

NAPI_MODULE_INIT() {
  napi_value available;
  napi_value attach;
  napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, NULL, &available);
  napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, NULL, &attach);
  napi_set_named_property(env, exports, "available", available);
  napi_set_named_property(env, exports, "attach", attach);
  return exports;
}
