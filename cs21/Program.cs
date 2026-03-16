using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Text;

namespace cs21;

abstract class Program
{
    private static readonly HttpClient Http = new();
    private const string BaseUrl = "https://platform.21-school.ru/services/21-school/api";
    private const string AuthUrl = "https://auth.21-school.ru/auth/realms/EduPowerKeycloak/protocol/openid-connect/token";

    private static string _defaultUsername = "";
    private static string _defaultPassword = "";
    private static int    _port            = 8080;

    private static readonly string SaveDir = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "saved");

    private static async Task Main(string[] args)
    {
        // Parse --username=X --password=Y --port=Z  (equals form)
        foreach (string arg in args)
        {
            if (arg.StartsWith("--username=")) _defaultUsername = arg.Substring("--username=".Length);
            else if (arg.StartsWith("--password=")) _defaultPassword = arg.Substring("--password=".Length);
            else if (arg.StartsWith("--port=") && int.TryParse(arg.Substring("--port=".Length), out int p)) _port = p;
        }
        // Parse --username X --password Y --port Z  (space form)
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--username") _defaultUsername = args[i + 1];
            if (args[i] == "--password") _defaultPassword = args[i + 1];
            if (args[i] == "--port" && int.TryParse(args[i + 1], out int p)) _port = p;
        }

        // Fallback: credentials.txt  (line 1: username, line 2: password, line 3: port)
        if (_defaultUsername == "" || _defaultPassword == "" || _port == 8080)
        {
            string credFile = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "credentials.txt");
            if (File.Exists(credFile))
            {
                string[] lines = await File.ReadAllLinesAsync(credFile);
                if (lines.Length >= 1 && _defaultUsername == "") _defaultUsername = lines[0].Trim();
                if (lines.Length >= 2 && _defaultPassword == "") _defaultPassword = lines[1].Trim();
                if (lines.Length >= 3 && int.TryParse(lines[2].Trim(), out int p)) _port = p;
            }
        }

        Directory.CreateDirectory(SaveDir);

        string htmlFile = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "school21-tracker.html");
        if (!File.Exists(htmlFile))
        {
            Console.WriteLine($"Файл не найден: {htmlFile}");
            Console.WriteLine("Положи school21-tracker.html рядом с Program.cs");
            Console.ReadKey();
            return;
        }

        HttpListener listener = new HttpListener();
        listener.Prefixes.Add($"http://localhost:{_port}/");
        listener.Start();

        Console.WriteLine("=================================");
        Console.WriteLine("  School21 Tracker Server");
        Console.WriteLine($"  http://localhost:{_port}/");
        if (_defaultUsername != "")
            Console.WriteLine($"  Пользователь: {_defaultUsername}");
        else
            Console.WriteLine("  Подсказка: создай credentials.txt рядом с Program.cs");
        Console.WriteLine("  Ctrl+C для остановки");
        Console.WriteLine("=================================");

        Process.Start(new ProcessStartInfo { FileName = $"http://localhost:{_port}/", UseShellExecute = true });

        while (true)
        {
            HttpListenerContext context = await listener.GetContextAsync();
            _ = Task.Run(() => HandleRequest(context, htmlFile));
        }
    }

    static async Task HandleRequest(HttpListenerContext context, string htmlFile)
    {
        HttpListenerRequest req = context.Request;
        HttpListenerResponse resp = context.Response;

        try
        {
            string path = req.Url!.AbsolutePath;
            Console.WriteLine($"{req.HttpMethod} {path}");

            // Serve HTML
            if (path == "/" || path == "/index.html")
            {
                string html = await File.ReadAllTextAsync(htmlFile);
                byte[] buf = Encoding.UTF8.GetBytes(html);
                resp.ContentType = "text/html; charset=utf-8";
                resp.ContentLength64 = buf.Length;
                await resp.OutputStream.WriteAsync(buf);
                resp.OutputStream.Close();
                return;
            }

            // Config
            if (path == "/config" && req.HttpMethod == "GET")
            {
                string u = EscapeJson(_defaultUsername);
                string p = EscapeJson(_defaultPassword);
                await WriteJson(resp, "{\"username\":\"" + u + "\",\"password\":\"" + p + "\"}");
                return;
            }

            // GET /settings — list all project IDs that have saved settings
            if (path == "/settings" && req.HttpMethod == "GET")
            {
                var projectIds = Directory.GetFiles(SaveDir, "settings_*.json")
                    .Select(f => Path.GetFileNameWithoutExtension(f).Substring("settings_".Length))
                    .OrderBy(id => id)
                    .ToList();
                string json = "[" + string.Join(",", projectIds.Select(id => "\"" + id + "\"")) + "]";
                await WriteJson(resp, json);
                return;
            }

            // GET /settings/{projectId} — load settings for a project
            if (path.StartsWith("/settings/") && req.HttpMethod == "GET")
            {
                string projectId = path.Substring("/settings/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string file = Path.Combine(SaveDir, $"settings_{projectId}.json");
                string json = File.Exists(file) ? await File.ReadAllTextAsync(file) : "{}";
                await WriteJson(resp, json);
                return;
            }

            // POST /settings/{projectId} — save settings for a project
            if (path.StartsWith("/settings/") && req.HttpMethod == "POST")
            {
                string projectId = path.Substring("/settings/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string body = await new StreamReader(req.InputStream, Encoding.UTF8).ReadToEndAsync();
                string file = Path.Combine(SaveDir, $"settings_{projectId}.json");
                await File.WriteAllTextAsync(file, body, Encoding.UTF8);
                await WriteJson(resp, "{\"ok\":true}");
                return;
            }

            // DELETE /settings/{projectId} — delete settings for a project
            if (path.StartsWith("/settings/") && req.HttpMethod == "DELETE")
            {
                string projectId = path.Substring("/settings/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string file = Path.Combine(SaveDir, $"settings_{projectId}.json");
                if (File.Exists(file)) File.Delete(file);
                await WriteJson(resp, "{\"ok\":true}");
                return;
            }

            // GET /saved/{projectId} — load saved logins for a project
            if (path.StartsWith("/saved/") && req.HttpMethod == "GET")
            {
                string projectId = path.Substring("/saved/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string file = Path.Combine(SaveDir, $"saved_{projectId}.json");
                string json = File.Exists(file) ? await File.ReadAllTextAsync(file) : "[]";
                await WriteJson(resp, json);
                return;
            }

            // POST /saved/{projectId} — save logins for a project
            if (path.StartsWith("/saved/") && req.HttpMethod == "POST")
            {
                string projectId = path.Substring("/saved/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string body = await new StreamReader(req.InputStream, Encoding.UTF8).ReadToEndAsync();
                string file = Path.Combine(SaveDir, $"saved_{projectId}.json");
                await File.WriteAllTextAsync(file, body, Encoding.UTF8);
                await WriteJson(resp, "{\"ok\":true}");
                return;
            }

            // DELETE /saved/{projectId} — clear saved list for a project
            if (path.StartsWith("/saved/") && req.HttpMethod == "DELETE")
            {
                string projectId = path.Substring("/saved/".Length).Trim('/');
                if (!IsValidId(projectId)) { resp.StatusCode = 400; resp.OutputStream.Close(); return; }
                string file = Path.Combine(SaveDir, $"saved_{projectId}.json");
                if (File.Exists(file)) File.Delete(file);
                await WriteJson(resp, "{\"ok\":true}");
                return;
            }

            // Proxy: /proxy/auth
            if (path == "/proxy/auth" && req.HttpMethod == "POST")
            {
                string body = await new StreamReader(req.InputStream).ReadToEndAsync();
                HttpRequestMessage proxyReq = new HttpRequestMessage(HttpMethod.Post, AuthUrl);
                proxyReq.Content = new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
                proxyReq.Headers.Add("origin", "https://platform.21-school.ru");
                HttpResponseMessage proxyResp = await Http.SendAsync(proxyReq);
                string respBody = await proxyResp.Content.ReadAsStringAsync();
                resp.ContentType = "application/json; charset=utf-8";
                resp.StatusCode = (int)proxyResp.StatusCode;
                byte[] buf = Encoding.UTF8.GetBytes(respBody);
                resp.ContentLength64 = buf.Length;
                await resp.OutputStream.WriteAsync(buf);
                resp.OutputStream.Close();
                return;
            }

            // Proxy: /proxy/api/* → BASE_URL/*
            if (path.StartsWith("/proxy/api/") && req.HttpMethod == "GET")
            {
                string apiPath = path.Substring("/proxy/api".Length);
                string query = req.Url.Query;
                string targetUrl = BaseUrl + apiPath + query;
                string token = req.Headers["X-Token"] ?? "";
                HttpRequestMessage proxyReq = new HttpRequestMessage(HttpMethod.Get, targetUrl);
                proxyReq.Headers.Add("Authorization", "Bearer " + token);
                HttpResponseMessage proxyResp = await Http.SendAsync(proxyReq);
                string respBody = await proxyResp.Content.ReadAsStringAsync();
                resp.ContentType = "application/json; charset=utf-8";
                resp.StatusCode = (int)proxyResp.StatusCode;
                byte[] buf = Encoding.UTF8.GetBytes(respBody);
                resp.ContentLength64 = buf.Length;
                await resp.OutputStream.WriteAsync(buf);
                resp.OutputStream.Close();
                return;
            }

            resp.StatusCode = 404;
            resp.OutputStream.Close();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Ошибка: {ex.Message}");
            try { resp.StatusCode = 500; resp.OutputStream.Close(); } catch { }
        }
    }

    static async Task WriteJson(HttpListenerResponse resp, string json)
    {
        byte[] buf = Encoding.UTF8.GetBytes(json);
        resp.ContentType = "application/json; charset=utf-8";
        resp.ContentLength64 = buf.Length;
        await resp.OutputStream.WriteAsync(buf);
        resp.OutputStream.Close();
    }

    static bool IsValidId(string id) =>
        !string.IsNullOrEmpty(id) && id.Length < 20 && id.All(c => char.IsLetterOrDigit(c) || c == '-' || c == '_');

    private static string EscapeJson(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
