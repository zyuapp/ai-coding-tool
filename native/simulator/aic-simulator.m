// Drives headless iOS simulators for the app's Simulator panel: streams the screen as H.264, injects
// touches, buttons and keys, takes screenshots, and reads the accessibility tree. CoreSimulator,
// SimulatorKit and AccessibilityPlatformTranslation are private frameworks, loaded at runtime so a
// machine without Xcode gets an answer instead of a crash.
//
// stdin: one JSON request per line, {"id": n, "op": "...", ...}.
// stdout: frames of [u32 big-endian length][u8 kind][payload].
//   kind 0: JSON, a response {"id", "ok", "result" | "error"} or an event {"event", ...}.
//   kind 1: video packet, [u16 header length][header JSON {udid, key, ts}][AVCC H.264 access unit].
//   kind 2: codec config, [u16 header length][header JSON {udid, width, height}][avcC record].

#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#include <dlfcn.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <unistd.h>

#pragma mark - Private interfaces

@protocol AICSimServiceContext
+ (instancetype)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end

@protocol AICSimDeviceSet
- (NSArray *)devices;
@end

@protocol AICSimDevice
- (NSUUID *)UDID;
- (unsigned long long)state;
- (id)io;
- (mach_port_t)lookup:(NSString *)name error:(NSError **)error;
- (void)sendAccessibilityRequestAsync:(id)request completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(id))handler;
@end

@protocol AICSimDeviceIO
- (NSArray *)ioPorts;
@end

@protocol AICSimPort
- (id)descriptor;
@end

@protocol AICSimScreen
- (id)framebufferSurface;
- (CGSize)displaySize;
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *))callback;
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(id))callback;
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid;
@end

@protocol AICHIDClient
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

@protocol AICTranslator
+ (instancetype)sharedInstance;
- (void)setBridgeTokenDelegate:(id)delegate;
- (void)setAccessibilityEnabled:(BOOL)enabled;
- (void)setSupportsDelegateTokens:(BOOL)supports;
- (id)frontmostApplicationWithDisplayId:(unsigned)display bridgeDelegateToken:(NSString *)token;
- (id)macPlatformElementFromTranslation:(id)translation;
@end

@protocol AICAudioClient
- (instancetype)initWithDevice:(id)device eventHandlerQueue:(dispatch_queue_t)queue error:(NSError **)error changedEventHandler:(void (^)(id))handler;
- (id)currentState;
- (void)routeGuestWithScope:(NSUInteger)scope to:(NSString *)uid completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(NSError *))handler;
@end

@protocol AICAudioState
- (NSArray *)inputDevices;
- (id)selectedInputDevice;
- (BOOL)useDefaultInputDevice;
@end

@protocol AICAudioHostDevice
- (NSString *)uniqueIdentifier;
- (NSUInteger)scope;
@end

typedef void *(*AICMouseMessage)(CGPoint *, CGPoint *, uint32_t, uint64_t, CGSize, uint32_t);
typedef void *(*AICKeyMessage)(uint32_t, uint32_t);
typedef void *(*AICButtonMessage)(uint32_t, uint32_t, uint32_t);

static const uint32_t kTouchTarget = 0x32;
static const uint32_t kButtonTarget = 0x33;
static const uint64_t kTouchDown = 1;
static const uint64_t kTouchUp = 2;
static const uint32_t kPress = 1;
static const uint32_t kRelease = 2;
static const unsigned long long kBooted = 3;
static const NSUInteger kMaxElements = 600;

static AICMouseMessage mouseMessage;
static AICKeyMessage keyMessage;
static AICButtonMessage buttonMessage;
static id<AICSimDeviceSet> deviceSet;
static dispatch_queue_t outputQueue;

#pragma mark - Output

static void writeAll(const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(STDOUT_FILENO, cursor, length);
    if (written <= 0) exit(0);
    cursor += written;
    length -= (size_t)written;
  }
}

static void emitFrame(uint8_t kind, NSData *payload) {
  dispatch_async(outputQueue, ^{
    uint32_t length = CFSwapInt32HostToBig((uint32_t)payload.length + 1);
    writeAll(&length, 4);
    writeAll(&kind, 1);
    writeAll(payload.bytes, payload.length);
  });
}

static void emitJSON(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (data) emitFrame(0, data);
}

static void emitBinary(uint8_t kind, NSDictionary *header, NSData *body) {
  NSData *headerData = [NSJSONSerialization dataWithJSONObject:header options:0 error:nil];
  NSMutableData *payload = [NSMutableData dataWithCapacity:2 + headerData.length + body.length];
  uint16_t headerLength = CFSwapInt16HostToBig((uint16_t)headerData.length);
  [payload appendBytes:&headerLength length:2];
  [payload appendData:headerData];
  [payload appendData:body];
  emitFrame(kind, payload);
}

static void respond(NSNumber *requestId, NSDictionary *result) {
  emitJSON(@{ @"id": requestId, @"ok": @YES, @"result": result ?: @{} });
}

static void fail(NSNumber *requestId, NSString *message) {
  emitJSON(@{ @"id": requestId, @"ok": @NO, @"error": message });
}

#pragma mark - Devices

@interface AICDevice : NSObject
@property (nonatomic, strong) id device;
@property (nonatomic, strong) id hid;
@property (nonatomic, strong) id audio;
@property (nonatomic, strong) dispatch_queue_t inputQueue;
@end

@implementation AICDevice
@end

static NSMutableDictionary<NSString *, AICDevice *> *devices;

static AICDevice *deviceFor(NSString *udid, NSString **error) {
  @synchronized (devices) {
    AICDevice *cached = devices[udid];
    if (cached) return cached;
    id found = nil;
    for (id<AICSimDevice> candidate in [deviceSet devices]) {
      if ([[candidate UDID].UUIDString isEqualToString:udid]) found = candidate;
    }
    if (!found) {
      *error = @"No simulator has that UDID.";
      return nil;
    }
    AICDevice *entry = [AICDevice new];
    entry.device = found;
    entry.inputQueue = dispatch_queue_create("aic.simulator.input", DISPATCH_QUEUE_SERIAL);
    devices[udid] = entry;
    return entry;
  }
}

static id<AICSimDevice> bootedDevice(AICDevice *entry, NSString **error) {
  id<AICSimDevice> device = entry.device;
  if ([device state] != kBooted) {
    *error = @"The simulator is not booted.";
    return nil;
  }
  return device;
}

static id<AICSimScreen> mainScreen(id<AICSimDevice> device) {
  id<AICSimScreen> fallback = nil;
  for (id<AICSimPort> port in [(id<AICSimDeviceIO>)[device io] ioPorts]) {
    id descriptor = [port descriptor];
    if (![descriptor respondsToSelector:@selector(framebufferSurface)]) continue;
    CGSize size = [(id<AICSimScreen>)descriptor displaySize];
    if (size.width > 0 && size.height > 0) return descriptor;
    fallback = fallback ?: descriptor;
  }
  return fallback;
}

#pragma mark - Input

static BOOL sendMessage(AICDevice *entry, void *message, NSString **error) {
  if (!message) {
    *error = @"SimulatorKit could not build that input.";
    return NO;
  }
  if (!entry.hid) {
    NSError *created = nil;
    Class client = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    entry.hid = [(id<AICHIDClient>)[client alloc] initWithDevice:entry.device error:&created];
    if (!entry.hid) {
      free(message);
      *error = created.localizedDescription ?: @"The simulator refused input.";
      return NO;
    }
  }
  __block NSError *sendError = nil;
  dispatch_semaphore_t sent = dispatch_semaphore_create(0);
  [(id<AICHIDClient>)entry.hid sendWithMessage:message freeWhenDone:YES completionQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0) completion:^(NSError *failure) {
    sendError = failure;
    dispatch_semaphore_signal(sent);
  }];
  if (dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) {
    *error = @"The simulator did not take the input in time.";
    entry.hid = nil;
    return NO;
  }
  if (sendError) {
    *error = sendError.localizedDescription;
    entry.hid = nil;
    return NO;
  }
  return YES;
}

static CGPoint onScreen(double x, double y) {
  return CGPointMake(fmin(fmax(x, 0), 1), fmin(fmax(y, 0), 1));
}

/** One finger, or two when `second` is given, as a pinch puts them. */
static void *touchMessage(double x, double y, const CGPoint *second, BOOL down) {
  CGPoint point = onScreen(x, y);
  CGPoint other = second ? onScreen(second->x, second->y) : CGPointZero;
  return mouseMessage(&point, second ? &other : NULL, kTouchTarget, down ? kTouchDown : kTouchUp, CGSizeMake(1, 1), 0);
}

static BOOL touch(AICDevice *entry, double x, double y, BOOL down, NSString **error) {
  return sendMessage(entry, touchMessage(x, y, NULL, down), error);
}

static BOOL key(AICDevice *entry, uint32_t usage, BOOL down, NSString **error) {
  return sendMessage(entry, keyMessage(usage, down ? kPress : kRelease), error);
}

/** US layout: the HID usage that types each printable ASCII character, and whether it needs Shift. */
static BOOL usageForCharacter(unichar character, uint32_t *usage, BOOL *shift) {
  static NSDictionary<NSString *, NSArray *> *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableDictionary *map = [NSMutableDictionary dictionary];
    for (unichar c = 'a'; c <= 'z'; c++) map[[NSString stringWithCharacters:&c length:1]] = @[@(4 + c - 'a'), @NO];
    for (unichar c = 'A'; c <= 'Z'; c++) map[[NSString stringWithCharacters:&c length:1]] = @[@(4 + c - 'A'), @YES];
    NSString *digits = @"1234567890";
    NSString *shifted = @"!@#$%^&*()";
    for (NSUInteger i = 0; i < 10; i++) {
      map[[digits substringWithRange:NSMakeRange(i, 1)]] = @[@(30 + i), @NO];
      map[[shifted substringWithRange:NSMakeRange(i, 1)]] = @[@(30 + i), @YES];
    }
    NSDictionary *punctuation = @{ @"\n": @40, @"\t": @43, @" ": @44, @"-": @45, @"=": @46, @"[": @47, @"]": @48, @"\\": @49, @";": @51, @"'": @52, @"`": @53, @",": @54, @".": @55, @"/": @56 };
    NSDictionary *shiftedPunctuation = @{ @"_": @45, @"+": @46, @"{": @47, @"}": @48, @"|": @49, @":": @51, @"\"": @52, @"~": @53, @"<": @54, @">": @55, @"?": @56 };
    [punctuation enumerateKeysAndObjectsUsingBlock:^(id k, id v, BOOL *stop) { map[k] = @[v, @NO]; }];
    [shiftedPunctuation enumerateKeysAndObjectsUsingBlock:^(id k, id v, BOOL *stop) { map[k] = @[v, @YES]; }];
    table = map;
  });
  NSArray *entry = table[[NSString stringWithCharacters:&character length:1]];
  if (!entry) return NO;
  *usage = [entry[0] unsignedIntValue];
  *shift = [entry[1] boolValue];
  return YES;
}

static BOOL typeString(AICDevice *entry, NSString *text, NSString **error) {
  for (NSUInteger i = 0; i < text.length; i++) {
    uint32_t usage;
    BOOL shift;
    if (!usageForCharacter([text characterAtIndex:i], &usage, &shift)) {
      *error = [NSString stringWithFormat:@"Cannot type \"%@\": only US keyboard characters can be typed.", [text substringWithRange:[text rangeOfComposedCharacterSequenceAtIndex:i]]];
      return NO;
    }
    if (shift && !key(entry, 225, YES, error)) return NO;
    if (!key(entry, usage, YES, error) || !key(entry, usage, NO, error)) return NO;
    if (shift && !key(entry, 225, NO, error)) return NO;
    usleep(8000);
  }
  return YES;
}

static BOOL pressButton(AICDevice *entry, NSString *button, NSString **error) {
  NSDictionary *sources = @{ @"home": @0, @"lock": @1 };
  NSNumber *source = sources[button];
  if (!source) {
    *error = @"Unknown button.";
    return NO;
  }
  if (!sendMessage(entry, buttonMessage(source.unsignedIntValue, kPress, kButtonTarget), error)) return NO;
  usleep(100000);
  return sendMessage(entry, buttonMessage(source.unsignedIntValue, kRelease, kButtonTarget), error);
}

static BOOL swipe(AICDevice *entry, double x0, double y0, double x1, double y1, double durationMs, NSString **error) {
  NSInteger steps = MAX(4, (NSInteger)(durationMs / 16));
  if (!touch(entry, x0, y0, YES, error)) return NO;
  for (NSInteger step = 1; step <= steps; step++) {
    usleep((useconds_t)(durationMs * 1000 / steps));
    double t = (double)step / steps;
    if (!touch(entry, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, YES, error)) return NO;
  }
  return touch(entry, x1, y1, NO, error);
}

/**
 * The GSEvent Simulator.app sends to turn a device: a device-orientation event (type 50, flagged as
 * coming from the host) carrying one UIDeviceOrientation, posted to the device's workspace port.
 */
#pragma pack(push, 4)
typedef struct {
  mach_msg_header_t header;
  uint32_t type;
  int32_t subtype;
  float location[2];
  float windowLocation[2];
  uint32_t windowContextId;
  uint64_t timestamp;
  uint32_t window;
  int32_t flags;
  int32_t senderPid;
  uint32_t infoSize;
  uint32_t orientation;
  uint8_t padding[28];
} AICOrientationEvent;
#pragma pack(pop)

static const uint32_t kOrientationEvent = 50;
static const uint32_t kHostEventFlag = 0x20000;
static const mach_msg_id_t kPurpleEventId = 123;

static BOOL rotate(AICDevice *entry, uint32_t orientation, NSString **error) {
  if (orientation < 1 || orientation > 4) {
    *error = @"Unknown orientation.";
    return NO;
  }
  NSError *lookupError = nil;
  mach_port_t port = [(id<AICSimDevice>)entry.device lookup:@"PurpleWorkspacePort" error:&lookupError];
  if (port == MACH_PORT_NULL) {
    *error = lookupError.localizedDescription ?: @"The simulator cannot be turned yet.";
    return NO;
  }
  AICOrientationEvent event = {0};
  event.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  event.header.msgh_size = sizeof(event);
  event.header.msgh_remote_port = port;
  event.header.msgh_id = kPurpleEventId;
  event.type = kOrientationEvent | kHostEventFlag;
  event.timestamp = mach_absolute_time();
  event.infoSize = sizeof(event.orientation);
  event.orientation = orientation;
  kern_return_t sent = mach_msg(&event.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(event), 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
  mach_port_deallocate(mach_task_self(), port);
  if (sent != KERN_SUCCESS) {
    *error = @"The simulator did not take the rotation.";
    return NO;
  }
  return YES;
}

#pragma mark - Audio

static UInt32 transportOf(NSString *uid) {
  CFStringRef name = (__bridge CFStringRef)uid;
  AudioDeviceID device = kAudioObjectUnknown;
  AudioValueTranslation translation = { &name, sizeof(name), &device, sizeof(device) };
  UInt32 size = sizeof(translation);
  AudioObjectPropertyAddress byUID = { kAudioHardwarePropertyDeviceForUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &byUID, 0, NULL, &size, &translation) != noErr || device == kAudioObjectUnknown) return 0;
  UInt32 transport = 0;
  size = sizeof(transport);
  AudioObjectPropertyAddress address = { kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &transport) != noErr) return 0;
  return transport;
}

/**
 * The Mac's own microphone, else another wired one. Bluetooth headsets drop to call quality while any
 * input on them is open, and a Continuity microphone would wake the phone, so neither is ever picked.
 */
static id<AICAudioHostDevice> quietInput(NSArray *inputs) {
  id<AICAudioHostDevice> wired = nil;
  for (id<AICAudioHostDevice> input in inputs) {
    if ([[input uniqueIdentifier] isEqualToString:@"BuiltInMicrophoneDevice"]) return input;
    UInt32 transport = transportOf([input uniqueIdentifier]);
    if (transport == kAudioDeviceTransportTypeBuiltIn && !wired) wired = input;
    if (transport == kAudioDeviceTransportTypeUSB && !wired) wired = input;
  }
  return wired;
}

/**
 * A device takes the Mac's default input unless told otherwise. It is pinned to a quiet input instead,
 * so a headset in use for something else keeps its sound while the simulator runs.
 */
static NSDictionary *quietAudio(AICDevice *entry, NSString **error) {
  dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
  __block id latest = nil;
  dispatch_semaphore_t changed = dispatch_semaphore_create(0);
  if (!entry.audio) {
    Class client = NSClassFromString(@"SimulatorKit.SimDeviceAudioClient");
    NSError *created = nil;
    entry.audio = [(id<AICAudioClient>)[client alloc] initWithDevice:entry.device eventHandlerQueue:queue error:&created changedEventHandler:^(id state) {
      latest = state;
      dispatch_semaphore_signal(changed);
    }];
    if (!entry.audio) {
      *error = created.localizedDescription ?: @"The simulator's audio could not be reached.";
      return nil;
    }
  }
  id<AICAudioState> state = latest ?: [(id<AICAudioClient>)entry.audio currentState];
  for (int attempt = 0; [[state inputDevices] count] == 0 && attempt < 20; attempt += 1) {
    dispatch_semaphore_wait(changed, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
    state = latest ?: [(id<AICAudioClient>)entry.audio currentState];
  }
  id<AICAudioHostDevice> target = quietInput([state inputDevices]);
  if (!target) return @{};
  NSString *uid = [target uniqueIdentifier];
  if (![state useDefaultInputDevice] && [[[state selectedInputDevice] uniqueIdentifier] isEqualToString:uid]) return @{ @"input": uid };
  __block NSError *routeError = nil;
  dispatch_semaphore_t routed = dispatch_semaphore_create(0);
  [(id<AICAudioClient>)entry.audio routeGuestWithScope:[target scope] to:uid completionQueue:queue completionHandler:^(NSError *failure) {
    routeError = failure;
    dispatch_semaphore_signal(routed);
  }];
  if (dispatch_semaphore_wait(routed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
    *error = @"The simulator did not take the audio route in time.";
    return nil;
  }
  if (routeError) {
    *error = routeError.localizedDescription;
    return nil;
  }
  return @{ @"input": uid };
}

#pragma mark - Screenshot

static NSDictionary *screenshot(id<AICSimDevice> device, NSString *path, NSString **error) {
  id<AICSimScreen> screen = mainScreen(device);
  IOSurfaceRef surface = (__bridge IOSurfaceRef)[screen framebufferSurface];
  if (!surface) {
    *error = @"The simulator has no screen yet.";
    return nil;
  }
  static CIContext *context;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ context = [CIContext contextWithOptions:nil]; });
  CIImage *image = [CIImage imageWithIOSurface:surface];
  CGImageRef cgImage = [context createCGImage:image fromRect:image.extent];
  if (!cgImage) {
    *error = @"Could not read the simulator's screen.";
    return nil;
  }
  CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], CFSTR("public.png"), 1, NULL);
  BOOL written = NO;
  if (destination) {
    CGImageDestinationAddImage(destination, cgImage, NULL);
    written = CGImageDestinationFinalize(destination);
    CFRelease(destination);
  }
  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);
  CGImageRelease(cgImage);
  if (!written) {
    *error = @"Could not save the screenshot.";
    return nil;
  }
  return @{ @"path": path, @"width": @(width), @"height": @(height) };
}

#pragma mark - Accessibility

@interface AICAccessibilityBridge : NSObject
@property (nonatomic, strong) NSMutableDictionary<NSString *, id> *devicesByToken;
@end

@implementation AICAccessibilityBridge

- (instancetype)init {
  if ((self = [super init])) _devicesByToken = [NSMutableDictionary dictionary];
  return self;
}

- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  id<AICSimDevice> device;
  @synchronized (self) { device = self.devicesByToken[token]; }
  return ^id(id request) {
    __block id response = nil;
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    [device sendAccessibilityRequestAsync:request completionQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0) completionHandler:^(id reply) {
      response = reply;
      dispatch_semaphore_signal(answered);
    }];
    dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    return response ?: [NSClassFromString(@"AXPTranslatorResponse") performSelector:@selector(emptyResponse)];
  };
}

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token {
  return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  return nil;
}

@end

static AICAccessibilityBridge *accessibilityBridge;

static NSString *stringValue(id value) {
  if (!value || value == [NSNull null]) return nil;
  if ([value isKindOfClass:[NSString class]]) return [(NSString *)value length] ? value : nil;
  if ([value isKindOfClass:[NSNumber class]]) return [value stringValue];
  if ([value isKindOfClass:[NSAttributedString class]]) return [(NSAttributedString *)value string];
  return nil;
}

static void collect(id element, NSInteger depth, NSString *token, NSMutableArray *out) {
  if (out.count >= kMaxElements || depth > 60) return;
  if ([element respondsToSelector:@selector(translation)]) {
    [[element performSelector:@selector(translation)] setValue:token forKey:@"bridgeDelegateToken"];
  }
  NSRect frame = [element accessibilityFrame];
  NSMutableDictionary *item = [NSMutableDictionary dictionary];
  item[@"depth"] = @(depth);
  item[@"role"] = stringValue([element accessibilityRole]) ?: @"AXUnknown";
  NSString *label = stringValue([element accessibilityLabel]);
  NSString *value = stringValue([element accessibilityValue]);
  NSString *identifier = [element respondsToSelector:@selector(accessibilityIdentifier)] ? stringValue([element accessibilityIdentifier]) : nil;
  if (label) item[@"label"] = label;
  if (value) item[@"value"] = value;
  if (identifier) item[@"identifier"] = identifier;
  item[@"frame"] = @[@(frame.origin.x), @(frame.origin.y), @(frame.size.width), @(frame.size.height)];
  [out addObject:item];
  for (id child in [element accessibilityChildren]) collect(child, depth + 1, token, out);
}

static NSDictionary *describe(id<AICSimDevice> device, NSString **error) {
  id<AICTranslator> translator = [NSClassFromString(@"AXPTranslator") sharedInstance];
  if (!translator) {
    *error = @"Accessibility translation is unavailable on this Mac.";
    return nil;
  }
  NSString *token = [NSUUID UUID].UUIDString;
  @synchronized (accessibilityBridge) { accessibilityBridge.devicesByToken[token] = device; }
  id translation = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:token];
  NSMutableArray *elements = [NSMutableArray array];
  NSString *application = nil;
  if (translation) {
    [translation setValue:token forKey:@"bridgeDelegateToken"];
    id root = [translator macPlatformElementFromTranslation:translation];
    application = stringValue([root accessibilityLabel]);
    collect(root, 0, token, elements);
  }
  @synchronized (accessibilityBridge) { [accessibilityBridge.devicesByToken removeObjectForKey:token]; }
  CGSize size = [mainScreen(device) displaySize];
  NSMutableDictionary *result = [@{ @"elements": elements, @"pixelWidth": @(size.width), @"pixelHeight": @(size.height) } mutableCopy];
  if (application) result[@"application"] = application;
  return result;
}

#pragma mark - Streaming

@interface AICStream : NSObject
@property (nonatomic, copy) NSString *udid;
@property (nonatomic, strong) id<AICSimScreen> screen;
@property (nonatomic, strong) NSUUID *callbackId;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, strong) dispatch_source_t timer;
@property (nonatomic, assign) VTCompressionSessionRef session;
@property (nonatomic, assign) int32_t width;
@property (nonatomic, assign) int32_t height;
@property (nonatomic, assign) BOOL dirty;
@property (nonatomic, assign) BOOL wantsKeyframe;
@property (nonatomic, assign) NSInteger watchers;
@property (nonatomic, strong) NSData *config;
@property (nonatomic, assign) CFAbsoluteTime started;
@property (nonatomic, assign) CFAbsoluteTime lastEncode;
@end

@implementation AICStream
@end

static NSMutableDictionary<NSString *, AICStream *> *streams;

static void compressed(void *context, void *frameContext, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
  AICStream *stream = (__bridge AICStream *)context;
  if (status != noErr || !sample || !CMSampleBufferDataIsReady(sample)) return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  BOOL keyframe = YES;
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef first = CFArrayGetValueAtIndex(attachments, 0);
    keyframe = !CFDictionaryContainsKey(first, kCMSampleAttachmentKey_NotSync);
  }
  if (keyframe) {
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    NSDictionary *atoms = (__bridge NSDictionary *)CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms);
    NSData *avcC = atoms[@"avcC"];
    if (avcC && ![avcC isEqualToData:stream.config]) stream.config = avcC;
    CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format);
    if (stream.config) emitBinary(2, @{ @"udid": stream.udid, @"width": @(dimensions.width), @"height": @(dimensions.height) }, stream.config);
  }
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t length = CMBlockBufferGetDataLength(block);
  NSMutableData *data = [NSMutableData dataWithLength:length];
  if (CMBlockBufferCopyDataBytes(block, 0, length, data.mutableBytes) != kCMBlockBufferNoErr) return;
  double timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1e6;
  emitBinary(1, @{ @"udid": stream.udid, @"key": @(keyframe), @"ts": @((long long)timestamp) }, data);
}

static void closeSession(AICStream *stream) {
  if (!stream.session) return;
  VTCompressionSessionCompleteFrames(stream.session, kCMTimeInvalid);
  VTCompressionSessionInvalidate(stream.session);
  CFRelease(stream.session);
  stream.session = NULL;
}

static BOOL openSession(AICStream *stream, int32_t width, int32_t height) {
  closeSession(stream);
  NSDictionary *specification = @{ (__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES };
  VTCompressionSessionRef session = NULL;
  OSStatus status = VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264, (__bridge CFDictionaryRef)specification, NULL, NULL, compressed, (__bridge void *)stream, &session);
  if (status != noErr) {
    status = VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264, NULL, NULL, NULL, compressed, (__bridge void *)stream, &session);
  }
  if (status != noErr) return NO;
  VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef)@(12 * 1000 * 1000));
  VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, (__bridge CFNumberRef)@2);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFNumberRef)@60);
  VTCompressionSessionPrepareToEncodeFrames(session);
  stream.session = session;
  stream.width = width;
  stream.height = height;
  stream.config = nil;
  stream.wantsKeyframe = YES;
  return YES;
}

static void encode(AICStream *stream) {
  IOSurfaceRef surface = (__bridge IOSurfaceRef)[stream.screen framebufferSurface];
  if (!surface) return;
  int32_t width = (int32_t)IOSurfaceGetWidth(surface);
  int32_t height = (int32_t)IOSurfaceGetHeight(surface);
  if (width < 2 || height < 2) return;
  if (!stream.session || width != stream.width || height != stream.height) {
    if (!openSession(stream, width, height)) return;
  }
  CVPixelBufferRef buffer = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &buffer) != kCVReturnSuccess) return;
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  CMTime time = CMTimeMakeWithSeconds(now - stream.started, 1000000);
  NSDictionary *options = stream.wantsKeyframe ? @{ (__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES } : nil;
  stream.wantsKeyframe = NO;
  stream.dirty = NO;
  stream.lastEncode = now;
  VTCompressionSessionEncodeFrame(stream.session, buffer, time, kCMTimeInvalid, (__bridge CFDictionaryRef)options, NULL, NULL);
  CVPixelBufferRelease(buffer);
}

static NSString *watch(NSString *udid, id<AICSimDevice> device) {
  @synchronized (streams) {
    AICStream *existing = streams[udid];
    if (existing) {
      existing.watchers += 1;
      dispatch_async(existing.queue, ^{
        existing.wantsKeyframe = YES;
        existing.dirty = YES;
      });
      return nil;
    }
    id<AICSimScreen> screen = mainScreen(device);
    if (!screen) return @"The simulator has no screen yet.";
    AICStream *stream = [AICStream new];
    stream.udid = udid;
    stream.screen = screen;
    stream.watchers = 1;
    stream.callbackId = [NSUUID UUID];
    stream.queue = dispatch_queue_create("aic.simulator.stream", DISPATCH_QUEUE_SERIAL);
    stream.started = CFAbsoluteTimeGetCurrent();
    stream.dirty = YES;
    stream.wantsKeyframe = YES;
    __weak AICStream *weak = stream;
    [screen registerCallbackWithUUID:stream.callbackId damageRectanglesCallback:^(NSArray *rects) {
      AICStream *strong = weak;
      if (strong) dispatch_async(strong.queue, ^{ strong.dirty = YES; });
    }];
    [screen registerCallbackWithUUID:stream.callbackId ioSurfacesChangeCallback:^(id surface) {
      AICStream *strong = weak;
      if (strong) dispatch_async(strong.queue, ^{ strong.dirty = YES; strong.wantsKeyframe = YES; });
    }];
    stream.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, stream.queue);
    dispatch_source_set_timer(stream.timer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 60, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(stream.timer, ^{
      AICStream *strong = weak;
      if (!strong) return;
      // A damage callback can be missed while the device settles, so a still screen is re-sent once a second.
      if (strong.dirty || strong.wantsKeyframe || CFAbsoluteTimeGetCurrent() - strong.lastEncode > 1) encode(strong);
    });
    dispatch_resume(stream.timer);
    streams[udid] = stream;
    return nil;
  }
}

static void unwatch(NSString *udid, BOOL all) {
  AICStream *stream;
  @synchronized (streams) {
    stream = streams[udid];
    if (!stream) return;
    stream.watchers = all ? 0 : stream.watchers - 1;
    if (stream.watchers > 0) return;
    [streams removeObjectForKey:udid];
  }
  [stream.screen unregisterDamageRectanglesCallbackWithUUID:stream.callbackId];
  [stream.screen unregisterIOSurfacesChangeCallbackWithUUID:stream.callbackId];
  dispatch_source_cancel(stream.timer);
  dispatch_sync(stream.queue, ^{ closeSession(stream); });
}

#pragma mark - Requests

static double number(NSDictionary *request, NSString *key, double fallback) {
  id value = request[key];
  return [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : fallback;
}

static void handle(NSDictionary *request) {
  NSNumber *requestId = [request[@"id"] isKindOfClass:[NSNumber class]] ? request[@"id"] : @0;
  NSString *op = request[@"op"];
  NSString *udid = request[@"udid"];
  if (![op isKindOfClass:[NSString class]] || ![udid isKindOfClass:[NSString class]]) {
    fail(requestId, @"Malformed request.");
    return;
  }
  NSString *error = nil;
  AICDevice *entry = deviceFor(udid, &error);
  if (!entry) {
    fail(requestId, error);
    return;
  }
  if ([op isEqualToString:@"unwatch"]) {
    unwatch(udid, NO);
    respond(requestId, nil);
    return;
  }
  id<AICSimDevice> device = bootedDevice(entry, &error);
  if (!device) {
    fail(requestId, error);
    return;
  }
  if ([op isEqualToString:@"watch"]) {
    error = watch(udid, device);
    if (error) fail(requestId, error);
    else respond(requestId, nil);
    return;
  }
  if ([op isEqualToString:@"describe"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *failure = nil;
      NSDictionary *result = describe(device, &failure);
      if (result) respond(requestId, result);
      else fail(requestId, failure);
    });
    return;
  }
  if ([op isEqualToString:@"quiet-audio"]) {
    dispatch_async(entry.inputQueue, ^{
      NSString *failure = nil;
      NSDictionary *result = quietAudio(entry, &failure);
      if (result) respond(requestId, result);
      else fail(requestId, failure);
    });
    return;
  }
  if ([op isEqualToString:@"screenshot"]) {
    NSString *path = request[@"path"];
    if (![path isKindOfClass:[NSString class]]) {
      fail(requestId, @"Malformed request.");
      return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *failure = nil;
      NSDictionary *result = screenshot(device, path, &failure);
      if (result) respond(requestId, result);
      else fail(requestId, failure);
    });
    return;
  }
  dispatch_async(entry.inputQueue, ^{
    NSString *failure = nil;
    BOOL ok;
    if ([op isEqualToString:@"touch"]) {
      NSString *phase = request[@"phase"];
      BOOL pinch = [request[@"x2"] isKindOfClass:[NSNumber class]] && [request[@"y2"] isKindOfClass:[NSNumber class]];
      CGPoint second = CGPointMake(number(request, @"x2", 0), number(request, @"y2", 0));
      ok = sendMessage(entry, touchMessage(number(request, @"x", 0), number(request, @"y", 0), pinch ? &second : NULL, ![phase isEqual:@"up"]), &failure);
    } else if ([op isEqualToString:@"tap"]) {
      double x = number(request, @"x", 0);
      double y = number(request, @"y", 0);
      ok = touch(entry, x, y, YES, &failure);
      if (ok) {
        usleep(60000);
        ok = touch(entry, x, y, NO, &failure);
      }
    } else if ([op isEqualToString:@"swipe"]) {
      ok = swipe(entry, number(request, @"x", 0), number(request, @"y", 0), number(request, @"toX", 0), number(request, @"toY", 0), fmin(fmax(number(request, @"durationMs", 300), 50), 5000), &failure);
    } else if ([op isEqualToString:@"button"]) {
      ok = pressButton(entry, request[@"button"], &failure);
    } else if ([op isEqualToString:@"rotate"]) {
      ok = rotate(entry, (uint32_t)number(request, @"orientation", 0), &failure);
    } else if ([op isEqualToString:@"key"]) {
      ok = key(entry, (uint32_t)number(request, @"usage", 0), [request[@"down"] boolValue], &failure);
    } else if ([op isEqualToString:@"type"]) {
      NSString *text = request[@"text"];
      ok = [text isKindOfClass:[NSString class]] && typeString(entry, text, &failure);
      if (!ok && !failure) failure = @"Malformed request.";
    } else {
      ok = NO;
      failure = [NSString stringWithFormat:@"Unknown op %@.", op];
    }
    if (ok) respond(requestId, nil);
    else fail(requestId, failure);
  });
}

static NSString *load(NSString *developerDir) {
  NSArray *coreSimulator = @[
    @"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"],
  ];
  BOOL loaded = NO;
  for (NSString *path in coreSimulator) loaded = loaded || dlopen(path.fileSystemRepresentation, RTLD_NOW) != NULL;
  if (!loaded) return @"Install Xcode to use the simulator.";
  NSString *kitPath = [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  void *kit = dlopen(kitPath.fileSystemRepresentation, RTLD_NOW);
  if (!kit) return @"Install Xcode to use the simulator.";
  dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW);
  mouseMessage = (AICMouseMessage)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
  keyMessage = (AICKeyMessage)dlsym(kit, "IndigoHIDMessageForKeyboardArbitrary");
  buttonMessage = (AICButtonMessage)dlsym(kit, "IndigoHIDMessageForButton");
  if (!mouseMessage || !keyMessage || !buttonMessage || !NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient")) {
    return @"This version of Xcode is not supported by the simulator panel yet.";
  }
  NSError *error = nil;
  id context = [(id<AICSimServiceContext>)NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developerDir error:&error];
  deviceSet = [(id<AICSimServiceContext>)context defaultDeviceSetWithError:&error];
  if (!deviceSet) return error.localizedDescription ?: @"CoreSimulator did not start.";
  id<AICTranslator> translator = [NSClassFromString(@"AXPTranslator") sharedInstance];
  accessibilityBridge = [AICAccessibilityBridge new];
  [translator setBridgeTokenDelegate:accessibilityBridge];
  [translator setAccessibilityEnabled:YES];
  if ([(id)translator respondsToSelector:@selector(setSupportsDelegateTokens:)]) [translator setSupportsDelegateTokens:YES];
  return nil;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    outputQueue = dispatch_queue_create("aic.simulator.output", DISPATCH_QUEUE_SERIAL);
    devices = [NSMutableDictionary dictionary];
    streams = [NSMutableDictionary dictionary];
    NSString *developerDir = argc > 1 ? @(argv[1]) : @"/Applications/Xcode.app/Contents/Developer";
    NSString *unavailable = load(developerDir);
    if (unavailable) {
      emitJSON(@{ @"event": @"unavailable", @"reason": unavailable });
      dispatch_sync(outputQueue, ^{});
      return 0;
    }
    emitJSON(@{ @"event": @"ready" });
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSFileHandle *input = [NSFileHandle fileHandleWithStandardInput];
      NSMutableData *buffer = [NSMutableData data];
      while (true) {
        NSData *chunk = [input availableData];
        if (chunk.length == 0) exit(0);
        [buffer appendData:chunk];
        while (true) {
          NSRange newline = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, buffer.length)];
          if (newline.location == NSNotFound) break;
          NSData *line = [buffer subdataWithRange:NSMakeRange(0, newline.location)];
          [buffer replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
          id request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
          if ([request isKindOfClass:[NSDictionary class]]) handle(request);
        }
      }
    });
    dispatch_main();
  }
}
