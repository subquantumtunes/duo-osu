<# :
@echo off
setlocal
title osu! co-op bridge
set "OSU_COOP_BRIDGE=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:OSU_COOP_BRIDGE))"
exit /b
#>

# osu! co-op bridge for Windows
# =============================
# Run this on the HOST computer (the one running osu!). Double-click it, then
# paste the pairing code it shows into the host page. Nothing to install: it
# uses the PowerShell that ships with Windows.
#
# It turns your partner's aim or taps into real mouse movement and key presses,
# and follows osu! stable through tosu (if running) for the synced playfield.
#
# Safety: it only listens on 127.0.0.1 (this computer), only accepts a page that
# knows the pairing code, and releases every key when the page disconnects.
# Close this window to stop all remote input instantly.

# ---- Settings (open this file in Notepad to change them) ----
$Port = 7273
$TosuPort = 24050
$FollowOsu = $true
# Screen area that maps to the shared video. Leave at 0 to use your main monitor.
# Set these if osu! runs on another monitor, e.g. X 1920, Y 0, Width 2560, Height 1440.
$AreaX = 0
$AreaY = 0
$AreaWidth = 0
$AreaHeight = 0
# -------------------------------------------------------------

$BridgeSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace OsuCoop
{
    public static class Json
    {
        public static object Parse(string s)
        {
            int i = 0;
            return Value(s, ref i);
        }

        public static object Get(object node, params string[] path)
        {
            foreach (string key in path)
            {
                Dictionary<string, object> map = node as Dictionary<string, object>;
                if (map == null || !map.TryGetValue(key, out node)) return null;
            }
            return node;
        }

        public static string Quote(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Num(double? value)
        {
            return value.HasValue ? value.Value.ToString("R", CultureInfo.InvariantCulture) : "null";
        }

        public static double? AsNumber(object value)
        {
            if (value is double) return (double)value;
            return null;
        }

        static void Skip(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        static object Value(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                i++;
                Dictionary<string, object> map = new Dictionary<string, object>();
                Skip(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return map; }
                while (true)
                {
                    Skip(s, ref i);
                    string key = Str(s, ref i);
                    Skip(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':'");
                    i++;
                    map[key] = Value(s, ref i);
                    Skip(s, ref i);
                    if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return map; }
                    throw new FormatException("Expected ',' or '}'");
                }
            }
            if (c == '[')
            {
                i++;
                List<object> list = new List<object>();
                Skip(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Value(s, ref i));
                    Skip(s, ref i);
                    if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return list; }
                    throw new FormatException("Expected ',' or ']'");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("Unexpected character in JSON");
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static bool Word(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static string Str(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') throw new FormatException("Expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("Bad escape");
                        sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                        i += 4;
                        break;
                    default: sb.Append(e); break;
                }
            }
            throw new FormatException("Unterminated string");
        }
    }

    static class Native
    {
        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x1;
        public const uint KEYEVENTF_KEYUP = 0x2;
        public const uint KEYEVENTF_SCANCODE = 0x8;

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        public delegate bool ConsoleCtrlHandler(int ctrlType);

        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
        [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

        static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
        [ThreadStatic] static bool threadDpiSet;

        // Without DPI awareness Windows reports scaled sizes and the cursor lands in the wrong place.
        public static void MakeProcessDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(PerMonitorV2)) return; } catch (Exception) { }
            try { if (SetProcessDpiAwareness(2) == 0) return; } catch (Exception) { }
            try { SetProcessDPIAware(); } catch (Exception) { }
        }

        public static void MakeThreadDpiAware()
        {
            if (threadDpiSet) return;
            threadDpiSet = true;
            try { SetThreadDpiAwarenessContext(PerMonitorV2); } catch (Exception) { }
        }
    }

    class Injector
    {
        static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>
        {
            { " ", 0x20 }, { "space", 0x20 }, { "spacebar", 0x20 },
            { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "backspace", 0x08 },
            { "esc", 0x1B }, { "escape", 0x1B },
            { "shift", 0xA0 }, { "shift_l", 0xA0 }, { "shift_r", 0xA1 },
            { "control", 0xA2 }, { "ctrl", 0xA2 }, { "ctrl_l", 0xA2 }, { "ctrl_r", 0xA3 },
            { "alt", 0xA4 }, { "alt_l", 0xA4 }, { "alt_r", 0xA5 }, { "altgraph", 0xA5 },
            { "arrowup", 0x26 }, { "up", 0x26 }, { "arrowdown", 0x28 }, { "down", 0x28 },
            { "arrowleft", 0x25 }, { "left", 0x25 }, { "arrowright", 0x27 }, { "right", 0x27 },
            { "capslock", 0x14 }, { "caps_lock", 0x14 },
            { "pageup", 0x21 }, { "page_up", 0x21 }, { "pagedown", 0x22 }, { "page_down", 0x22 },
            { "home", 0x24 }, { "end", 0x23 }, { "insert", 0x2D }, { "delete", 0x2E },
        };

        static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0xA3, 0xA5 };

        readonly int rx, ry, rw, rh;
        readonly object gate = new object();
        readonly bool[] held = new bool[2];
        readonly ushort[] bindings = new ushort[2];
        bool warnedFailure;

        public Injector(int x, int y, int width, int height)
        {
            rx = x; ry = y; rw = width; rh = height;
            bindings[0] = ParseKey("z");
            bindings[1] = ParseKey("x");
        }

        public static ushort ParseKey(string name)
        {
            string raw = (name ?? "").ToLowerInvariant();
            ushort vk;
            if (Named.TryGetValue(raw, out vk)) return vk;
            raw = raw.Trim();
            if (Named.TryGetValue(raw, out vk)) return vk;
            if (raw.Length > 1 && raw[0] == 'f')
            {
                int n;
                if (int.TryParse(raw.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
            }
            if (raw.Length == 1)
            {
                short scan = Native.VkKeyScan(raw[0]);
                if (scan != -1) return (ushort)(scan & 0xFF);
            }
            throw new ArgumentException("Unknown key: " + name);
        }

        public void Aim(double x, double y)
        {
            Native.MakeThreadDpiAware();
            if (double.IsNaN(x) || double.IsNaN(y)) return;
            x = Math.Min(Math.Max(x, 0.0), 1.0);
            y = Math.Min(Math.Max(y, 0.0), 1.0);
            Native.SetCursorPos((int)(rx + x * (rw - 1)), (int)(ry + y * (rh - 1)));
        }

        public void Key(int slot, bool down)
        {
            lock (gate)
            {
                if (down == held[slot]) return;
                held[slot] = down;
                Press(bindings[slot], down);
            }
        }

        public void ReleaseAll()
        {
            lock (gate)
            {
                for (int slot = 0; slot < held.Length; slot++)
                {
                    if (!held[slot]) continue;
                    held[slot] = false;
                    Press(bindings[slot], false);
                }
            }
        }

        public void Configure(string k1, string k2)
        {
            ReleaseAll();
            try
            {
                ushort a = ParseKey(k1), b = ParseKey(k2);
                lock (gate) { bindings[0] = a; bindings[1] = b; }
                Console.WriteLine("Key bindings: K1 = '" + k1 + "', K2 = '" + k2 + "'");
            }
            catch (ArgumentException error)
            {
                Console.WriteLine("Ignoring key config: " + error.Message);
            }
        }

        void Press(ushort vk, bool down)
        {
            uint scan = Native.MapVirtualKey(vk, 0);
            Native.INPUT input = new Native.INPUT();
            input.type = Native.INPUT_KEYBOARD;
            input.u.ki.wVk = scan == 0 ? vk : (ushort)0;
            input.u.ki.wScan = (ushort)scan;
            uint flags = scan == 0 ? 0 : Native.KEYEVENTF_SCANCODE;
            if (Extended.Contains(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            if (!down) flags |= Native.KEYEVENTF_KEYUP;
            input.u.ki.dwFlags = flags;
            uint sent = Native.SendInput(1, new Native.INPUT[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent == 0 && !warnedFailure)
            {
                warnedFailure = true;
                Console.WriteLine("Windows blocked a key press. If osu! runs as administrator, run this bridge as administrator too.");
            }
        }
    }

    class PageConnection
    {
        const int MaxMessage = 4096;
        readonly TcpClient client;
        readonly NetworkStream stream;
        readonly BufferedStream reader;
        readonly object sendGate = new object();
        volatile bool closed;

        public PageConnection(TcpClient client)
        {
            this.client = client;
            client.NoDelay = true;
            stream = client.GetStream();
            reader = new BufferedStream(stream, 8192);
        }

        public int ReadTimeout { set { stream.ReadTimeout = value; } }

        public bool Handshake()
        {
            stream.ReadTimeout = 5000;
            string key = null;
            int total = 0;
            bool firstLine = true;
            while (true)
            {
                string line = ReadLine(ref total);
                if (line == null) return false;
                if (line.Length == 0) break;
                if (firstLine)
                {
                    firstLine = false;
                    if (!line.StartsWith("GET ", StringComparison.Ordinal)) return false;
                    continue;
                }
                int colon = line.IndexOf(':');
                if (colon > 0 && string.Equals(line.Substring(0, colon).Trim(), "Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                    key = line.Substring(colon + 1).Trim();
            }
            if (key == null) return false;
            string accept;
            using (SHA1 sha = SHA1.Create())
                accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            byte[] response = Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
            lock (sendGate) stream.Write(response, 0, response.Length);
            return true;
        }

        string ReadLine(ref int total)
        {
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                int b = reader.ReadByte();
                if (b < 0) return null;
                if (++total > 8192) return null;
                if (b == '\n')
                {
                    if (sb.Length > 0 && sb[sb.Length - 1] == '\r') sb.Length--;
                    return sb.ToString();
                }
                sb.Append((char)b);
            }
        }

        int Next()
        {
            int b = reader.ReadByte();
            if (b < 0) throw new EndOfStreamException();
            return b;
        }

        byte[] ReadExact(int count)
        {
            byte[] data = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = reader.Read(data, offset, count - offset);
                if (read <= 0) throw new EndOfStreamException();
                offset += read;
            }
            return data;
        }

        public string Receive()
        {
            MemoryStream message = new MemoryStream();
            while (true)
            {
                int b0 = reader.ReadByte();
                if (b0 < 0) return null;
                int b1 = Next();
                bool fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                bool masked = (b1 & 0x80) != 0;
                long length = b1 & 0x7F;
                if (length == 126) length = (Next() << 8) | Next();
                else if (length == 127)
                {
                    ulong longLength = 0;
                    for (int n = 0; n < 8; n++) longLength = (longLength << 8) | (uint)Next();
                    length = longLength > (ulong)MaxMessage ? MaxMessage + 1L : (long)longLength;
                }
                if (!masked || length > MaxMessage) { Close(); return null; }
                byte[] mask = ReadExact(4);
                byte[] data = ReadExact((int)length);
                for (int n = 0; n < data.Length; n++) data[n] ^= mask[n & 3];

                if (opcode == 0x8) { SendFrame(0x8, new byte[0]); Close(); return null; }
                if (opcode == 0x9) { SendFrame(0xA, data); continue; }
                if (opcode == 0xA) continue;
                message.Write(data, 0, data.Length);
                if (message.Length > MaxMessage) { Close(); return null; }
                if (fin) return Encoding.UTF8.GetString(message.ToArray());
            }
        }

        public void Send(string text)
        {
            SendFrame(0x1, Encoding.UTF8.GetBytes(text));
        }

        void SendFrame(int opcode, byte[] payload)
        {
            if (closed) return;
            int headerLength = payload.Length < 126 ? 2 : payload.Length <= 0xFFFF ? 4 : 10;
            byte[] frame = new byte[headerLength + payload.Length];
            frame[0] = (byte)(0x80 | opcode);
            if (headerLength == 2) frame[1] = (byte)payload.Length;
            else if (headerLength == 4)
            {
                frame[1] = 126;
                frame[2] = (byte)(payload.Length >> 8);
                frame[3] = (byte)payload.Length;
            }
            else
            {
                frame[1] = 127;
                long length = payload.Length;
                for (int n = 0; n < 8; n++) frame[9 - n] = (byte)(length >> (8 * n));
            }
            Buffer.BlockCopy(payload, 0, frame, headerLength, payload.Length);
            try
            {
                lock (sendGate) stream.Write(frame, 0, frame.Length);
            }
            catch (Exception)
            {
                Close();
            }
        }

        public void Close()
        {
            if (closed) return;
            closed = true;
            try { client.Close(); } catch (Exception) { }
        }
    }

    class OsuWatcher
    {
        const double Playing = 2;
        const long MaxMapBytes = 4000000;
        const double MinTimeIntervalMs = 3;

        readonly int port;
        readonly Action<string> push;
        readonly object gate = new object();
        readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
        string source;
        double? state;
        double mods;
        double? offset;
        string checksum;
        string mapMessage;
        double lastTimeSent = -1000;
        volatile bool precise;
        bool warned;

        public OsuWatcher(int port, Action<string> push)
        {
            this.port = port;
            this.push = push;
        }

        string StatusMessage()
        {
            return "{\"t\":\"osu\",\"source\":" + Json.Quote(source) + ",\"state\":" + Json.Num(state) +
                ",\"mods\":" + Json.Num(mods) + ",\"offset\":" + Json.Num(offset) + "}";
        }

        public List<string> Greeting()
        {
            lock (gate)
            {
                List<string> messages = new List<string> { StatusMessage() };
                if (mapMessage != null) messages.Add(mapMessage);
                return messages;
            }
        }

        void Set(string newSource, double? newState, double newMods, double? newOffset)
        {
            string message = null;
            lock (gate)
            {
                if (newSource != source || newState != state || newMods != mods || newOffset != offset)
                {
                    source = newSource; state = newState; mods = newMods; offset = newOffset;
                    message = StatusMessage();
                }
            }
            if (message != null) push(message);
        }

        void Connected(string name)
        {
            Console.WriteLine("Connected to " + name + ". Your partner gets a synced playfield.");
            warned = false;
            Set(name, state, mods, offset);
        }

        void Time(object value)
        {
            double? ms = Json.AsNumber(value);
            if (!ms.HasValue) return;
            lock (gate)
            {
                double now = clock.Elapsed.TotalMilliseconds;
                if (now - lastTimeSent < MinTimeIntervalMs) return;
                lastTimeSent = now;
            }
            push("{\"t\":\"time\",\"ms\":" + Json.Num(ms) + "}");
        }

        void LoadMap(object hash, object songs, string relative)
        {
            string newChecksum = hash as string;
            if (string.IsNullOrEmpty(newChecksum) || string.IsNullOrEmpty(relative) || newChecksum == checksum) return;
            checksum = newChecksum;
            string message = null;
            try
            {
                string path = Path.Combine((songs as string) ?? "", relative);
                if (new FileInfo(path).Length > MaxMapBytes) throw new IOException("file is too large");
                string text = File.ReadAllText(path, Encoding.UTF8);
                message = "{\"t\":\"map\",\"checksum\":" + Json.Quote(newChecksum) + ",\"text\":" + Json.Quote(text) + "}";
                Console.WriteLine("Beatmap: " + Path.GetFileName(path));
            }
            catch (Exception error)
            {
                Console.WriteLine("Couldn't read the beatmap file (" + error.Message + ").");
            }
            lock (gate) mapMessage = message;
            if (message != null) push(message);
        }

        static ClientWebSocket Open(string url)
        {
            ClientWebSocket ws = new ClientWebSocket();
            if (!ws.ConnectAsync(new Uri(url), CancellationToken.None).Wait(3000))
            {
                ws.Abort();
                throw new TimeoutException();
            }
            return ws;
        }

        static string ReceiveText(ClientWebSocket ws, byte[] buffer)
        {
            MemoryStream message = new MemoryStream();
            while (true)
            {
                WebSocketReceiveResult result = ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None).Result;
                if (result.MessageType == WebSocketMessageType.Close) return null;
                message.Write(buffer, 0, result.Count);
                if (result.EndOfMessage) return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            }
        }

        void FollowPrecise(ClientWebSocket ws)
        {
            byte[] buffer = new byte[65536];
            try
            {
                // Newer tosu builds dropped currentTime from the precise feed; only switch
                // away from beatmap.time.live once this feed actually carries a time.
                while (true)
                {
                    string raw = ReceiveText(ws, buffer);
                    if (raw == null) break;
                    double? ms = Json.AsNumber(Json.Get(Json.Parse(raw), "currentTime"));
                    if (!ms.HasValue) continue;
                    precise = true;
                    Time(ms.Value);
                }
            }
            catch (Exception) { }
            finally { precise = false; }
        }

        void FollowTosu()
        {
            string baseUrl = "ws://127.0.0.1:" + port;
            using (ClientWebSocket ws = Open(baseUrl + "/websocket/v2"))
            {
                Connected("tosu");
                ClientWebSocket preciseSocket = null;
                try
                {
                    preciseSocket = Open(baseUrl + "/websocket/v2/precise");
                    ClientWebSocket socket = preciseSocket;
                    Thread thread = new Thread(delegate () { FollowPrecise(socket); });
                    thread.IsBackground = true;
                    thread.Start();
                }
                catch (Exception) { }
                try
                {
                    byte[] buffer = new byte[65536];
                    while (true)
                    {
                        string raw = ReceiveText(ws, buffer);
                        if (raw == null) return;
                        object data = Json.Parse(raw);
                        double? newState = Json.AsNumber(Json.Get(data, "state", "number"));
                        double newMods = mods;
                        if (newState == Playing) newMods = Json.AsNumber(Json.Get(data, "play", "mods", "number")) ?? 0;
                        double? newOffset = Json.AsNumber(Json.Get(data, "settings", "audio", "offset", "universal"));
                        Set(source, newState, newMods, newOffset);
                        LoadMap(Json.Get(data, "beatmap", "checksum"), Json.Get(data, "folders", "songs"),
                            Json.Get(data, "directPath", "beatmapFile") as string);
                        if (!precise) Time(Json.Get(data, "beatmap", "time", "live"));
                    }
                }
                finally
                {
                    if (preciseSocket != null) preciseSocket.Abort();
                }
            }
        }

        void FollowGosumemory()
        {
            using (ClientWebSocket ws = Open("ws://127.0.0.1:" + port + "/ws"))
            {
                Connected("gosumemory");
                byte[] buffer = new byte[65536];
                while (true)
                {
                    string raw = ReceiveText(ws, buffer);
                    if (raw == null) return;
                    object data = Json.Parse(raw);
                    Set(source, Json.AsNumber(Json.Get(data, "menu", "state")),
                        Json.AsNumber(Json.Get(data, "menu", "mods", "num")) ?? 0, offset);
                    string folder = Json.Get(data, "menu", "bm", "path", "folder") as string;
                    string file = Json.Get(data, "menu", "bm", "path", "file") as string;
                    LoadMap(Json.Get(data, "menu", "bm", "md5"), Json.Get(data, "settings", "folders", "songs"),
                        string.IsNullOrEmpty(file) ? null : Path.Combine(folder ?? "", file));
                    Time(Json.Get(data, "menu", "bm", "time", "current"));
                }
            }
        }

        public void Run()
        {
            while (true)
            {
                try { FollowTosu(); } catch (Exception) { }
                try { FollowGosumemory(); } catch (Exception) { }
                if (source != null) Console.WriteLine("Lost the connection to tosu. Your partner falls back to video only.");
                else if (!warned)
                {
                    Console.WriteLine("tosu isn't running (port " + port + "). Start it for the synced playfield; retrying...");
                    warned = true;
                }
                Set(null, null, mods, offset);
                Thread.Sleep(3000);
            }
        }
    }

    public static class Bridge
    {
        const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        static readonly object activeGate = new object();
        static readonly ManualResetEvent stop = new ManualResetEvent(false);
        static PageConnection active;
        static Injector injector;
        static OsuWatcher watcher;
        static string token;
        static int[] region;
        static Native.ConsoleCtrlHandler ctrlHandler;

        public static void Run(int port, int x, int y, int width, int height, int tosuPort, bool noSync)
        {
            try { Native.MakeProcessDpiAware(); Native.MakeThreadDpiAware(); } catch (Exception) { }
            region = new int[] { x, y, width, height };
            if (width <= 0 || height <= 0)
            {
                region = new int[] { 0, 0, 1920, 1080 };
                try { region = new int[] { 0, 0, Native.GetSystemMetrics(0), Native.GetSystemMetrics(1) }; } catch (Exception) { }
            }

            token = MakeToken();
            injector = new Injector(region[0], region[1], region[2], region[3]);
            watcher = new OsuWatcher(tosuPort, Push);

            ctrlHandler = OnConsoleEvent;
            try { Native.SetConsoleCtrlHandler(ctrlHandler, true); } catch (Exception) { }

            TcpListener listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                listener.Start();
            }
            catch (SocketException)
            {
                Console.WriteLine("Port " + port + " is already in use. Is another bridge window already open?");
                return;
            }

            string rule = new string('=', 46);
            Console.WriteLine(rule);
            Console.WriteLine(" osu! co-op bridge is running");
            Console.WriteLine(" Listening on   ws://127.0.0.1:" + port);
            Console.WriteLine(" Aim region     " + region[2] + "x" + region[3] + " at (" + region[0] + ", " + region[1] + ")");
            Console.WriteLine(" Pairing code   " + token.Substring(0, 4) + "-" + token.Substring(4));
            Console.WriteLine(rule);
            Console.WriteLine("Paste the pairing code into the host page. Close this window to stop.");

            Thread accept = new Thread(delegate () { AcceptLoop(listener); });
            accept.IsBackground = true;
            accept.Start();

            if (!noSync)
            {
                Thread follow = new Thread(watcher.Run);
                follow.IsBackground = true;
                follow.Start();
            }

            stop.WaitOne();
            listener.Stop();
            injector.ReleaseAll();
            Console.WriteLine("Bridge stopped. All keys released.");
        }

        static bool OnConsoleEvent(int ctrlType)
        {
            if (injector != null) injector.ReleaseAll();
            if (ctrlType == 0 || ctrlType == 1)
            {
                stop.Set();
                return true;
            }
            return false;
        }

        static string MakeToken()
        {
            byte[] bytes = new byte[8];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            StringBuilder sb = new StringBuilder();
            foreach (byte b in bytes) sb.Append(Alphabet[b % Alphabet.Length]);
            return sb.ToString();
        }

        static string Normalize(string value)
        {
            return (value ?? "").Replace("-", "").Replace(" ", "").ToUpperInvariant();
        }

        static bool SameToken(string candidate)
        {
            if (candidate.Length != token.Length) return false;
            int diff = 0;
            for (int n = 0; n < token.Length; n++) diff |= candidate[n] ^ token[n];
            return diff == 0;
        }

        static void Push(string message)
        {
            PageConnection page;
            lock (activeGate) page = active;
            if (page != null) page.Send(message);
        }

        static void AcceptLoop(TcpListener listener)
        {
            while (true)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (Exception) { return; }
                Thread thread = new Thread(delegate () { Handle(client); });
                thread.IsBackground = true;
                thread.Start();
            }
        }

        static bool AsBool(object value)
        {
            return value is bool && (bool)value;
        }

        static void Handle(TcpClient client)
        {
            PageConnection page = new PageConnection(client);
            bool live = false;
            try
            {
                if (!page.Handshake()) { page.Close(); return; }
                Console.WriteLine("Page connecting...");
                string hello = page.Receive();
                page.ReadTimeout = Timeout.Infinite;
                object helloJson = hello == null ? null : Json.Parse(hello);
                if ((Json.Get(helloJson, "t") as string) != "auth" || !SameToken(Normalize(Json.Get(helloJson, "token") as string)))
                {
                    Console.WriteLine("Rejected a page with the wrong pairing code.");
                    Thread.Sleep(1000);
                    page.Send("{\"t\":\"error\",\"reason\":\"bad-token\"}");
                    page.Close();
                    return;
                }

                PageConnection previous;
                lock (activeGate) { previous = active; active = page; }
                if (previous != null) previous.Close();
                live = true;

                page.Send("{\"t\":\"ok\",\"screen\":[" + region[2] + "," + region[3] + "]}");
                foreach (string message in watcher.Greeting()) page.Send(message);
                Console.WriteLine("Host page connected. Remote input is LIVE.");

                while (true)
                {
                    string raw = page.Receive();
                    if (raw == null) break;
                    object msg;
                    try { msg = Json.Parse(raw); }
                    catch (FormatException) { continue; }
                    string kind = Json.Get(msg, "t") as string;
                    if (kind == "aim")
                    {
                        injector.Aim(Json.AsNumber(Json.Get(msg, "x")) ?? 0, Json.AsNumber(Json.Get(msg, "y")) ?? 0);
                    }
                    else if (kind == "key")
                    {
                        string slot = Json.Get(msg, "k") as string;
                        if (slot == "k1" || slot == "k2") injector.Key(slot == "k1" ? 0 : 1, AsBool(Json.Get(msg, "down")));
                    }
                    else if (kind == "release")
                    {
                        injector.ReleaseAll();
                    }
                    else if (kind == "config")
                    {
                        injector.Configure((Json.Get(msg, "k1") as string) ?? "z", (Json.Get(msg, "k2") as string) ?? "x");
                    }
                }
            }
            catch (Exception) { }
            finally
            {
                page.Close();
                if (live)
                {
                    injector.ReleaseAll();
                    bool wasActive;
                    lock (activeGate)
                    {
                        wasActive = active == page;
                        if (wasActive) active = null;
                    }
                    Console.WriteLine("Host page disconnected. All keys released.");
                }
            }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $BridgeSource -Language CSharp -IgnoreWarnings
    [OsuCoop.Bridge]::Run($Port, $AreaX, $AreaY, $AreaWidth, $AreaHeight, $TosuPort, -not $FollowOsu)
}
catch {
    Write-Host ""
    Write-Host "The bridge stopped with an error:" -ForegroundColor Red
    Write-Host $_.Exception.Message
}
Read-Host "Press Enter to close"
