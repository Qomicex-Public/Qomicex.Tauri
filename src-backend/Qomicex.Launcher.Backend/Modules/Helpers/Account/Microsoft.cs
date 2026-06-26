using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Qomicex.Launcher.Backend.Common;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Account
{
    public class Microsoft
    {
        private string _clientId;

        public Microsoft(string clientId)
        {
            _clientId = clientId;
        }

        public class OAuthResponse
        {
            public string DeviceCode { get; set; } = string.Empty;
            public string UserCode { get; set; } = string.Empty;
            public string VerificationUri { get; set; } = string.Empty;
            public int ExpiresIn { get; set; }
            public int Interval { get; set; }
        }

        public async Task<OAuthResponse> OAuthLogin()
        {
            Debug.WriteLine("开始认证...");
            Debug.WriteLine("获取 Device Code...");
            HttpClient http = new HttpClient();

            var formData = new Dictionary<string, string>
            {
                { "client_id", _clientId },
                { "scope", "offline_access XboxLive.signin XboxLive.offline_access" }
            };
            var content = new FormUrlEncodedContent(formData);
            var response = await http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", content);
            string result = await response.Content.ReadAsStringAsync();
            if (response.IsSuccessStatusCode)
            {
                Debug.WriteLine("解析Device Code...");
                using var doc = JsonDocument.Parse(result);
                var root = doc.RootElement;
                var oauthResponse = new OAuthResponse
                {
                    DeviceCode = root.TryGetProperty("device_code", out var dc) ? dc.GetString() ?? string.Empty : string.Empty,
                    UserCode = root.TryGetProperty("user_code", out var uc) ? uc.GetString() ?? string.Empty : string.Empty,
                    VerificationUri = root.TryGetProperty("verification_uri", out var vu) ? vu.GetString() ?? string.Empty : string.Empty,
                    ExpiresIn = root.TryGetProperty("expires_in", out var ei) ? ei.GetInt32() : 0,
                    Interval = root.TryGetProperty("interval", out var iv) ? iv.GetInt32() : 5
                };
                Debug.WriteLine("成功解析 Device Code");
                return oauthResponse;
            }
            else
            {
                Debug.WriteLine("无法解析 Device Code 响应");
                throw ApiException.BadGateway("获取 device code 失败", inner: new Exception(result));
            }
        }

        public async Task<Dictionary<string, string>> GetUserAuthorizationState(OAuthResponse oAuthResponse)
        {
            Debug.WriteLine("开始获取用户授权状态...");
            Debug.WriteLine($"使用 DeviceCode: {oAuthResponse.DeviceCode.Substring(0, 10)}... 发起请求");

            HttpClient http = new HttpClient();
            var formData = new Dictionary<string, string>
            {
                { "client_id", _clientId },
                { "grant_type", "urn:ietf:params:oauth:grant-type:device_code" },
                { "device_code", oAuthResponse.DeviceCode! }
            };
            var content = new FormUrlEncodedContent(formData);

            Debug.WriteLine("向令牌端点发送授权请求...");
            var response = await http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", content);
            string result = await response.Content.ReadAsStringAsync();

            if (response.IsSuccessStatusCode)
            {
                Debug.WriteLine("授权请求响应成功，开始解析结果...");
                if (!string.IsNullOrEmpty(result))
                {
                    using var doc = JsonDocument.Parse(result);
                    var root = doc.RootElement;

                    string err = root.TryGetProperty("error", out var errProp) ? errProp.GetString() ?? string.Empty : string.Empty;
                    if (string.IsNullOrEmpty(err))
                    {
                        Debug.WriteLine("成功获取用户授权，获取到 access_token 和 refresh_token");
                        return new Dictionary<string, string>
                        {
                            { "access_token", root.TryGetProperty("access_token", out var at) ? at.GetString() ?? string.Empty : string.Empty },
                            { "refresh_token", root.TryGetProperty("refresh_token", out var rt) ? rt.GetString() ?? string.Empty : string.Empty }
                        };
                    }
                    else
                    {
                        Debug.WriteLine($"授权请求返回错误: {err}");
                        return new Dictionary<string, string>
                        {
                            { "error", err }
                        };
                    }
                }
                else
                {
                    Debug.WriteLine("授权响应结果为空字符串");
                    return new Dictionary<string, string>();
                }
            }
            else
            {
                Debug.WriteLine($"授权请求HTTP失败: {response.StatusCode}，响应内容: {result}");
                return new Dictionary<string, string>();
            }
        }

        public async Task<DataModules.DataDetails.Account> GetUserInfo(string accessToken, string refresh_token)
        {
            Debug.WriteLine("开始获取用户信息流程...");
            Debug.WriteLine($"使用 access_token: {accessToken.Substring(0, 10)}... 发起验证");

            HttpClient http = new HttpClient();
            string minecraftAccessToken = string.Empty;
            string xboxToken = string.Empty;
            string xboxUhs = string.Empty;

            //Xbox Live验证
            Debug.WriteLine("进入 Xbox Live 身份验证步骤...");
            var payload = new JsonObject
            {
                ["Properties"] = new JsonObject
                {
                    ["AuthMethod"] = "RPS",
                    ["SiteName"] = "user.auth.xboxlive.com",
                    ["RpsTicket"] = $"d={accessToken}"
                },
                ["RelyingParty"] = "http://auth.xboxlive.com",
                ["TokenType"] = "JWT"
            };

            var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            http.DefaultRequestHeaders.Accept.Clear();
            http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            Debug.WriteLine("向 Xbox Live 验证端点发送请求...");
            var response = await http.PostAsync("https://user.auth.xboxlive.com/user/authenticate", content);

            if (response.IsSuccessStatusCode)
            {
                Debug.WriteLine("Xbox Live 验证响应成功，解析结果...");
                var result = await response.Content.ReadAsStringAsync();
                using var xboxDoc = JsonDocument.Parse(result);
                var xboxRoot = xboxDoc.RootElement;

                xboxToken = xboxRoot.TryGetProperty("Token", out var tokenProp) ? tokenProp.GetString() ?? string.Empty : string.Empty;
                if (xboxRoot.TryGetProperty("DisplayClaims", out var dc) &&
                    dc.TryGetProperty("xui", out var xui) &&
                    xui.ValueKind == JsonValueKind.Array &&
                    xui.GetArrayLength() > 0)
                {
                    xboxUhs = xui[0].TryGetProperty("uhs", out var uhs) ? uhs.GetString() ?? string.Empty : string.Empty;
                }

                if (string.IsNullOrEmpty(xboxToken) || string.IsNullOrEmpty(xboxUhs))
                {
                    Debug.WriteLine("Xbox Live 验证结果缺少 Token 或 Uhs 字段");
                    throw ApiException.BadGateway("Xbox Live 验证结果解析失败：缺少关键字段");
                }
                Debug.WriteLine($"Xbox Live 验证成功，Uhs: {xboxUhs}");
            }
            else
            {
                var error = await response.Content.ReadAsStringAsync();
                Debug.WriteLine($"Xbox Live 身份验证HTTP失败: {response.StatusCode}，错误内容: {error}");
                throw ApiException.BadGateway("Xbox Live 身份验证失败", inner: new Exception(error));
            }

            //XSTS身份验证
            Debug.WriteLine("进入 XSTS 身份验证步骤...");
            var xstsPayload = new JsonObject
            {
                ["Properties"] = new JsonObject
                {
                    ["SandboxId"] = "RETAIL",
                    ["UserTokens"] = new JsonArray { xboxToken }
                },
                ["RelyingParty"] = "rp://api.minecraftservices.com/",
                ["TokenType"] = "JWT"
            };
            var xstsContent = new StringContent(xstsPayload.ToJsonString(), Encoding.UTF8, "application/json");

            Debug.WriteLine("向 XSTS 验证端点发送请求...");
            var xstsResponse = await http.PostAsync("https://xsts.auth.xboxlive.com/xsts/authorize", xstsContent);
            if (xstsResponse.IsSuccessStatusCode)
            {
                Debug.WriteLine("XSTS 验证响应成功，解析结果...");
                var xstsResult = await xstsResponse.Content.ReadAsStringAsync();
                using var xstsDoc = JsonDocument.Parse(xstsResult);
                var xstsRoot = xstsDoc.RootElement;

                string xstsToken = xstsRoot.TryGetProperty("Token", out var xt) ? xt.GetString() ?? string.Empty : string.Empty;
                string userHash = string.Empty;
                if (xstsRoot.TryGetProperty("DisplayClaims", out var dc2) &&
                    dc2.TryGetProperty("xui", out var xui2) &&
                    xui2.ValueKind == JsonValueKind.Array &&
                    xui2.GetArrayLength() > 0)
                {
                    userHash = xui2[0].TryGetProperty("uhs", out var uhs2) ? uhs2.GetString() ?? string.Empty : string.Empty;
                }

                if (string.IsNullOrEmpty(xstsToken) || string.IsNullOrEmpty(userHash))
                {
                    Debug.WriteLine("XSTS 验证结果缺少 Token 或 UserHash 字段");
                    throw ApiException.BadGateway("XSTS 验证结果解析失败：缺少关键字段");
                }
                Debug.WriteLine("XSTS 验证成功，准备 Minecraft 身份验证");

                //Minecraft身份验证
                Debug.WriteLine("进入 Minecraft 身份验证步骤...");
                var minecraftPayload = new JsonObject
                {
                    ["identityToken"] = $"XBL3.0 x={userHash};{xstsToken}"
                };
                var minecraftContent = new StringContent(minecraftPayload.ToJsonString(), Encoding.UTF8, "application/json");

                Debug.WriteLine("向 Minecraft 验证端点发送请求...");
                var minecraftResponse = await http.PostAsync("https://api.minecraftservices.com/authentication/login_with_xbox", minecraftContent);
                if (minecraftResponse.IsSuccessStatusCode)
                {
                    Debug.WriteLine("Minecraft 验证响应成功，解析 access_token...");
                    var minecraftResult = await minecraftResponse.Content.ReadAsStringAsync();
                    using var minecraftDoc = JsonDocument.Parse(minecraftResult);
                    var minecraftRoot = minecraftDoc.RootElement;
                    minecraftAccessToken = minecraftRoot.TryGetProperty("access_token", out var mat) ? mat.GetString() ?? string.Empty : string.Empty;

                    if (string.IsNullOrEmpty(minecraftAccessToken))
                    {
                        Debug.WriteLine("Minecraft 验证结果缺少 access_token");
                        throw ApiException.BadGateway("Minecraft 验证失败");
                    }
                    Debug.WriteLine($"Minecraft 验证成功，access_token: {minecraftAccessToken.Substring(0, 10)}...");

                    //检查游戏是否拥有
                    Debug.WriteLine("开始检查游戏所有权...");
                    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", minecraftAccessToken);
                    response = await http.GetAsync("https://api.minecraftservices.com/entitlements/mcstore");

                    if (response.IsSuccessStatusCode)
                    {
                        Debug.WriteLine("游戏所有权请求响应成功，解析结果...");
                        using var itemsDoc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                        var itemsRoot = itemsDoc.RootElement;

                        if (!itemsRoot.TryGetProperty("items", out var itemsElement) ||
                            itemsElement.ValueKind != JsonValueKind.Array ||
                            itemsElement.GetArrayLength() == 0)
                        {
                            Debug.WriteLine("游戏所有权响应中无物品数据");
                            throw ApiException.BadGateway("游戏所有权验证失败：无响应数据");
                        }

                        bool isActive = false;
                        foreach (var item in itemsElement.EnumerateArray())
                        {
                            if (item.TryGetProperty("name", out var nameProp) && nameProp.GetString() == "game_minecraft")
                            {
                                isActive = true;
                                break;
                            }
                        }

                        if (isActive)
                        {
                            Debug.WriteLine("验证通过：用户拥有 Minecraft 游戏所有权");
                        }
                        else
                        {
                            Debug.WriteLine("游戏所有权中未找到 game_minecraft 条目");
                            throw ApiException.BadRequest("未购买游戏", "NO_GAME_PURCHASED");
                        }
                    }
                    else
                    {
                        var error = await response.Content.ReadAsStringAsync();
                        Debug.WriteLine($"游戏所有权验证HTTP失败: {response.StatusCode}，错误内容: {error}");
                        throw ApiException.BadGateway("游戏所有权验证失败", inner: new Exception(error));
                    }
                }
                else
                {
                    var error = await minecraftResponse.Content.ReadAsStringAsync();
                    Debug.WriteLine($"Minecraft 身份验证HTTP失败: {minecraftResponse.StatusCode}，错误内容: {error}");
                    throw ApiException.BadGateway("Minecraft 身份验证失败", inner: new Exception(error));
                }
            }
            else
            {
                var error = await xstsResponse.Content.ReadAsStringAsync();
                Debug.WriteLine($"XSTS 身份验证HTTP失败: {xstsResponse.StatusCode}，错误内容: {error}");
                throw ApiException.BadRequest("XSTS 验证失败", "XSTS_FAILED");
            }

            //获取用户信息
            Debug.WriteLine("开始获取 Minecraft 账户信息...");
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", minecraftAccessToken);
            response = await http.GetAsync("https://api.minecraftservices.com/minecraft/profile");

            if (response.IsSuccessStatusCode)
            {
                Debug.WriteLine("账户信息请求响应成功，解析用户数据...");
                using var dataDoc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                var dataRoot = dataDoc.RootElement;

                var userInfo = new DataModules.DataDetails.Account();
                userInfo.Name = dataRoot.TryGetProperty("name", out var nameProp2) ? nameProp2.GetString() ?? string.Empty : string.Empty;
                userInfo.Uuid = dataRoot.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? string.Empty : string.Empty;
                userInfo.Token = minecraftAccessToken;
                userInfo.RefreshToken = refresh_token;
                userInfo.LoginMethod = "Microsoft";

                if (string.IsNullOrEmpty(userInfo.Name) || string.IsNullOrEmpty(userInfo.Uuid))
                {
                    Debug.WriteLine("账户信息缺少 Name 或 Uuid 字段");
                    throw ApiException.BadGateway("获取用户信息失败：返回数据不完整");
                }
                Debug.WriteLine($"成功获取用户信息，用户名: {userInfo.Name}，UUID: {userInfo.Uuid}");
                return userInfo;
            }
            else
            {
                var error = await response.Content.ReadAsStringAsync();
                Debug.WriteLine($"获取账户数据HTTP失败: {response.StatusCode}，错误内容: {error}");
                throw ApiException.BadGateway("获取 Minecraft 账户信息失败", inner: new Exception(error));
            }
        }

        public async Task<DataModules.DataDetails.Account> RefreshUserInfo(string refreshToken)
        {
            Debug.WriteLine("开始刷新用户信息流程...");
            Debug.WriteLine($"使用 refresh_token: {refreshToken.Substring(0, 10)}... 发起请求");

            HttpClient http = new HttpClient();
            var access_token = string.Empty;
            var new_refresh_token = string.Empty;

            Debug.WriteLine("构建令牌刷新请求参数...");
            var formData = new Dictionary<string, string>
            {
                { "client_id", _clientId },
                { "grant_type", "refresh_token" },
                { "scope", "XboxLive.signin offline_access" },
                { "refresh_token", refreshToken }
            };
            var content = new FormUrlEncodedContent(formData);

            Debug.WriteLine("向令牌端点发送刷新请求...");
            var response = await http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", content);
            string result = await response.Content.ReadAsStringAsync();

            if (response.IsSuccessStatusCode)
            {
                Debug.WriteLine("令牌刷新请求响应成功，解析结果...");
                if (!string.IsNullOrEmpty(result))
                {
                    using var doc = JsonDocument.Parse(result);
                    var root = doc.RootElement;

                    string err = root.TryGetProperty("error", out var errProp) ? errProp.GetString() ?? string.Empty : string.Empty;
                    if (string.IsNullOrEmpty(err))
                    {
                        access_token = root.TryGetProperty("access_token", out var at) ? at.GetString() ?? string.Empty : string.Empty;
                        new_refresh_token = root.TryGetProperty("refresh_token", out var rt) ? rt.GetString() ?? string.Empty : string.Empty;

                        if (string.IsNullOrEmpty(access_token) || string.IsNullOrEmpty(new_refresh_token))
                        {
                            Debug.WriteLine("令牌刷新结果缺少 access_token 或 refresh_token");
                            throw ApiException.BadGateway("令牌刷新失败：缺少关键令牌字段");
                        }
                        Debug.WriteLine($"令牌刷新成功，新 access_token: {access_token.Substring(0, 10)}...");
                        Debug.WriteLine("调用 GetUserInfo 获取最新用户信息...");
                        return await GetUserInfo(access_token, new_refresh_token);
                    }
                    else
                    {
                        Debug.WriteLine($"令牌刷新失败: {err}，响应内容: {result}");
                        throw ApiException.BadGateway("令牌刷新失败", inner: new Exception(err));
                    }
                }
                else
                {
                    Debug.WriteLine("令牌刷新响应结果为空字符串");
                    throw ApiException.BadGateway("令牌刷新失败：响应为空");
                }
            }
            else
            {
                Debug.WriteLine($"令牌刷新HTTP失败: {response.StatusCode}，响应内容: {result}");
                throw ApiException.BadGateway("令牌刷新HTTP请求失败");
            }
        }
    }
}
