using Newtonsoft.Json.Linq;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Account
{
    public class Microsoft
    {
        public string ClientId { get => _clientId; set => _clientId = value; }
        private string _clientId = string.Empty;

        private static readonly HttpClient _http = new();

        public class OAuthResponse
        {
            public string DeviceCode = string.Empty;
            public string UserCode = string.Empty;
            public string VerificationUri = string.Empty;
            public int ExpiresIn { get; set; }
            public int Interval { get; set; }
        }

        public async Task<OAuthResponse> OAuthLogin()
        {
            //获取 device code
            Trace.WriteLine("开始认证...");
            Trace.WriteLine("获取 Device Code...");
            var formData = new Dictionary<string, string>
            {
                { "client_id", _clientId },
                { "scope", "offline_access XboxLive.signin XboxLive.offline_access" }
            };
            var content = new FormUrlEncodedContent(formData);
            var response = await _http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", content);
            string result = await response.Content.ReadAsStringAsync();
            if (response.IsSuccessStatusCode)
            {
                // 解析 device code
                Trace.WriteLine("解析Device Code...");
                var deviceCode = JObject.Parse(result);
                if (deviceCode != null)
                {
                    var oauthResponse = new OAuthResponse
                    {
                        DeviceCode = deviceCode["device_code"]?.ToString()!,
                        UserCode = deviceCode["user_code"]?.ToString()!,
                        VerificationUri = deviceCode["verification_uri"]?.ToString()!,
                        ExpiresIn = deviceCode["expires_in"]?.Value<int>() ?? 0,
                        Interval = deviceCode["interval"]?.Value<int>() ?? 5
                    };
                    Trace.WriteLine("成功解析 Device Code");
                    return oauthResponse;
                }
                else
                {
                    Trace.WriteLine("无法解析 Device Code 响应");
                    throw new Exception("无法解析 device code 响应");
                }
            }
            else
            {
                throw new Exception($"获取 device code 失败: {result}");
            }
        }

        public async Task<Dictionary<string, string>> GetUserAuthorizationState(OAuthResponse oAuthResponse)
        {
            Trace.WriteLine("开始获取用户授权状态...");
            Trace.WriteLine($"使用 DeviceCode: {oAuthResponse.DeviceCode.Substring(0, 10)}... 发起请求");

            var formData = new Dictionary<string, string>
    {
        { "client_id", _clientId },
        { "grant_type", "urn:ietf:params:oauth:grant-type:device_code" },
        { "device_code", oAuthResponse.DeviceCode! }
    };
            var content = new FormUrlEncodedContent(formData);

            Trace.WriteLine("向令牌端点发送授权请求...");
            var response = await _http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", content);
            string result = await response.Content.ReadAsStringAsync();

            if (response.IsSuccessStatusCode)
            {
                Trace.WriteLine("授权请求响应成功，开始解析结果...");
                if (!string.IsNullOrEmpty(result))
                {
                    var data = JObject.Parse(result);
                    if (data != null)
                    {
                        string err = data["error"]?.ToString() ?? string.Empty;
                        if (string.IsNullOrEmpty(err))
                        {
                            Trace.WriteLine("成功获取用户授权，获取到 access_token 和 refresh_token");
                            return new Dictionary<string, string>
                    {
                        { "access_token", data["access_token"]?.ToString() ?? string.Empty },
                        { "refresh_token", data["refresh_token"]?.ToString() ?? string.Empty }
                    };
                        }
                        else
                        {
                            Trace.WriteLine($"授权请求返回错误: {err}");
                            return new Dictionary<string, string>
                    {
                        { "error", err }
                    };
                        }
                    }
                    else
                    {
                        Trace.WriteLine("无法解析授权响应数据（JObject 为空）");
                        return new Dictionary<string, string>();
                    }
                }
                else
                {
                    Trace.WriteLine("授权响应结果为空字符串");
                    return new Dictionary<string, string>();
                }
            }
            else
            {
                Trace.WriteLine($"授权请求HTTP失败: {response.StatusCode}，响应内容: {result}");
                return new Dictionary<string, string>();
            }
        }

        public async Task<DataModules.DataDetails.Account> GetUserInfo(string accessToken, string refresh_token)
        {
            Trace.WriteLine("开始获取用户信息流程...");
            Trace.WriteLine($"使用 access_token: {accessToken.Substring(0, 10)}... 发起验证");

            string minecraftAccessToken = string.Empty;
            string xboxToken = string.Empty;
            string xboxUhs = string.Empty;

            //Xbox Live验证
            Trace.WriteLine("进入 Xbox Live 身份验证步骤...");
            var payload = new JObject
            {
                ["Properties"] = new JObject
                {
                    ["AuthMethod"] = "RPS",
                    ["SiteName"] = "user.auth.xboxlive.com",
                    ["RpsTicket"] = $"d={accessToken}"
                },
                ["RelyingParty"] = "http://auth.xboxlive.com",
                ["TokenType"] = "JWT"
            };

            using var xboxReq = new HttpRequestMessage(HttpMethod.Post, "https://user.auth.xboxlive.com/user/authenticate")
            {
                Content = new StringContent(payload.ToString(), Encoding.UTF8, "application/json")
            };
            xboxReq.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            Trace.WriteLine("向 Xbox Live 验证端点发送请求...");
            var response = await _http.SendAsync(xboxReq);

            if (response.IsSuccessStatusCode)
            {
                Trace.WriteLine("Xbox Live 验证响应成功，解析结果...");
                var result = await response.Content.ReadAsStringAsync();
                var xboxObj = JObject.Parse(result);
                if (xboxObj != null)
                {
                    xboxToken = xboxObj["Token"]?.ToString() ?? string.Empty;
                    xboxUhs = xboxObj["DisplayClaims"]?["xui"]?[0]?["uhs"]?.ToString() ?? string.Empty;

                    if (string.IsNullOrEmpty(xboxToken) || string.IsNullOrEmpty(xboxUhs))
                    {
                        Trace.WriteLine("Xbox Live 验证结果缺少 Token 或 Uhs 字段");
                        throw new Exception("Xbox Live 验证结果解析失败：缺少关键字段");
                    }
                    Trace.WriteLine($"Xbox Live 验证成功，Uhs: {xboxUhs}");
                }
                else
                {
                    Trace.WriteLine("无法解析 Xbox Live 验证响应（JObject 为空）");
                    throw new Exception("无法解析 Xbox Live 验证响应");
                }
            }
            else
            {
                var error = await response.Content.ReadAsStringAsync();
                Trace.WriteLine($"Xbox Live 身份验证HTTP失败: {response.StatusCode}，错误内容: {error}");
                throw new Exception($"Xbox Live 身份验证失败: {response.StatusCode}\n{error}");
            }

            //XSTS身份验证
            Trace.WriteLine("进入 XSTS 身份验证步骤...");
            var xstsPayload = new JObject
            {
                ["Properties"] = new JObject
                {
                    ["SandboxId"] = "RETAIL",
                    ["UserTokens"] = new JArray(xboxToken)
                },
                ["RelyingParty"] = "rp://api.minecraftservices.com/",
                ["TokenType"] = "JWT"
            };
            var xstsContent = new StringContent(xstsPayload.ToString(), Encoding.UTF8, "application/json");

            Trace.WriteLine("向 XSTS 验证端点发送请求...");
            var xstsResponse = await _http.PostAsync("https://xsts.auth.xboxlive.com/xsts/authorize", xstsContent);
            if (xstsResponse.IsSuccessStatusCode)
            {
                Trace.WriteLine("XSTS 验证响应成功，解析结果...");
                var xstsResult = await xstsResponse.Content.ReadAsStringAsync();
                var xstsObj = JObject.Parse(xstsResult);
                if (xstsObj != null)
                {
                    string xstsToken = xstsObj["Token"]?.ToString() ?? string.Empty;
                    string userHash = xstsObj["DisplayClaims"]?["xui"]?[0]?["uhs"]?.ToString() ?? string.Empty;

                    if (string.IsNullOrEmpty(xstsToken) || string.IsNullOrEmpty(userHash))
                    {
                        Trace.WriteLine("XSTS 验证结果缺少 Token 或 UserHash 字段");
                        throw new Exception("XSTS 验证结果解析失败：缺少关键字段");
                    }
                    Trace.WriteLine("XSTS 验证成功，准备 Minecraft 身份验证");

                    //Minecraft身份验证
                    Trace.WriteLine("进入 Minecraft 身份验证步骤...");
                    var minecraftPayload = new JObject
                    {
                        ["identityToken"] = $"XBL3.0 x={userHash};{xstsToken}"
                    };
                    var minecraftContent = new StringContent(minecraftPayload.ToString(), Encoding.UTF8, "application/json");

                    Trace.WriteLine("向 Minecraft 验证端点发送请求...");
                    var minecraftResponse = await _http.PostAsync("https://api.minecraftservices.com/authentication/login_with_xbox", minecraftContent);
                    if (minecraftResponse.IsSuccessStatusCode)
                    {
                        Trace.WriteLine("Minecraft 验证响应成功，解析 access_token...");
                        var minecraftResult = await minecraftResponse.Content.ReadAsStringAsync();
                        var minecraftObj = JObject.Parse(minecraftResult);
                        minecraftAccessToken = minecraftObj["access_token"]?.ToString() ?? string.Empty;

                        if (string.IsNullOrEmpty(minecraftAccessToken))
                        {
                            Trace.WriteLine("Minecraft 验证结果缺少 access_token");
                            throw new Exception("Minecraft 身份验证失败：未获取到 access_token");
                        }
                        Trace.WriteLine($"Minecraft 验证成功，access_token: {minecraftAccessToken.Substring(0, 10)}...");

                        //检查游戏是否拥有
                        Trace.WriteLine("开始检查游戏所有权...");
                        using var entitleReq = new HttpRequestMessage(HttpMethod.Get, "https://api.minecraftservices.com/entitlements/mcstore");
                        entitleReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", minecraftAccessToken);
                        response = await _http.SendAsync(entitleReq);

                        if (response.IsSuccessStatusCode)
                        {
                            Trace.WriteLine("游戏所有权请求响应成功，解析结果...");
                            var itemsObj = JObject.Parse(await response.Content.ReadAsStringAsync());
                            if (itemsObj != null && itemsObj["items"] != null)
                            {
                                var items = itemsObj["items"] as JArray;
                                if (items == null || items.Count == 0)
                                {
                                    Trace.WriteLine("游戏所有权响应中无物品数据");
                                    throw new Exception("未找到游戏所有权信息");
                                }

                                bool isActive = false;
                                foreach (var item in items)
                                {
                                    if (item["name"]?.ToString() == "game_minecraft")
                                    {
                                        isActive = true;
                                        break;
                                    }
                                }

                                if (isActive)
                                {
                                    Trace.WriteLine("验证通过：用户拥有 Minecraft 游戏所有权");
                                }
                                else
                                {
                                    Trace.WriteLine("游戏所有权中未找到 game_minecraft 条目");
                                    throw new Exception("未找到游戏所有权信息");
                                }
                            }
                            else
                            {
                                Trace.WriteLine("无法解析游戏所有权响应（items 字段为空）");
                                throw new Exception("无法解析游戏所有权响应");
                            }
                        }
                        else
                        {
                            var error = await response.Content.ReadAsStringAsync();
                            Trace.WriteLine($"游戏所有权验证HTTP失败: {response.StatusCode}，错误内容: {error}");
                            throw new Exception($"游戏所有权验证失败: {response.StatusCode}\n{error}");
                        }
                    }
                    else
                    {
                        var error = await minecraftResponse.Content.ReadAsStringAsync();
                        Trace.WriteLine($"Minecraft 身份验证HTTP失败: {minecraftResponse.StatusCode}，错误内容: {error}");
                        throw new Exception($"Minecraft 身份验证失败: {minecraftResponse.StatusCode}");
                    }
                }
                else
                {
                    Trace.WriteLine("无法解析 XSTS 验证响应（JObject 为空）");
                    throw new Exception("无法解析 XSTS 验证响应");
                }
            }
            else
            {
                var error = await xstsResponse.Content.ReadAsStringAsync();
                Trace.WriteLine($"XSTS 身份验证HTTP失败: {xstsResponse.StatusCode}，错误内容: {error}");
                throw new Exception($"XSTS 身份验证失败: {xstsResponse.StatusCode}");
            }

            //获取用户信息
            Trace.WriteLine("开始获取 Minecraft 账户信息...");
            using var profileReq = new HttpRequestMessage(HttpMethod.Get, "https://api.minecraftservices.com/minecraft/profile");
            profileReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", minecraftAccessToken);
            response = await _http.SendAsync(profileReq);

            if (response.IsSuccessStatusCode)
            {
                Trace.WriteLine("账户信息请求响应成功，解析用户数据...");
                var dataObj = JObject.Parse(await response.Content.ReadAsStringAsync());
                if (dataObj != null)
                {
                    var userInfo = new DataModules.DataDetails.Account();
                    userInfo.Name = dataObj["name"]?.ToString() ?? string.Empty;
                    userInfo.Uuid = dataObj["id"]?.ToString() ?? string.Empty;
                    userInfo.Token = minecraftAccessToken;
                    userInfo.RefreshToken = refresh_token;
                    userInfo.LoginMethod = "Microsoft";

                    if (string.IsNullOrEmpty(userInfo.Name) || string.IsNullOrEmpty(userInfo.Uuid))
                    {
                        Trace.WriteLine("账户信息缺少 Name 或 Uuid 字段");
                        throw new Exception("解析用户信息失败：缺少关键字段");
                    }
                    Trace.WriteLine($"成功获取用户信息，用户名: {userInfo.Name}，UUID: {userInfo.Uuid}");
                    return userInfo;
                }
                else
                {
                    Trace.WriteLine("无法解析账户信息响应（JObject 为空）");
                    throw new Exception("无法解析用户信息响应");
                }
            }
            else
            {
                var error = await response.Content.ReadAsStringAsync();
                Trace.WriteLine($"获取账户数据HTTP失败: {response.StatusCode}，错误内容: {error}");
                throw new Exception($"获取账户数据失败: {response.StatusCode}\n{error}");
            }
        }

        public async Task<DataModules.DataDetails.Account> RefreshUserInfo(string refreshToken)
        {
            Trace.WriteLine("开始刷新用户信息流程...");
            Trace.WriteLine($"使用 refresh_token: {refreshToken.Substring(0, 10)}... 发起请求");

            var access_token = string.Empty;
            var new_refresh_token = string.Empty;

            Trace.WriteLine("构建令牌刷新请求参数...");
            var formData = new Dictionary<string, string>
    {
        { "client_id", _clientId },
        { "grant_type", "refresh_token" },
        { "scope", "XboxLive.signin offline_access" },
        { "refresh_token", refreshToken }
    };
            var content = new FormUrlEncodedContent(formData);

            Trace.WriteLine("向令牌端点发送刷新请求...");
            var response = await _http.PostAsync("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", content);
            string result = await response.Content.ReadAsStringAsync();

            if (response.IsSuccessStatusCode)
            {
                Trace.WriteLine("令牌刷新请求响应成功，解析结果...");
                if (!string.IsNullOrEmpty(result))
                {
                    var data = JObject.Parse(result);
                    if (data != null)
                    {
                        string err = data["error"]?.ToString() ?? string.Empty;
                        if (string.IsNullOrEmpty(err))
                        {
                            access_token = data["access_token"]?.ToString() ?? string.Empty;
                            new_refresh_token = data["refresh_token"]?.ToString() ?? string.Empty;

                            if (string.IsNullOrEmpty(access_token) || string.IsNullOrEmpty(new_refresh_token))
                            {
                                Trace.WriteLine("令牌刷新结果缺少 access_token 或 refresh_token");
                                throw new Exception("令牌刷新失败：缺少关键令牌字段");
                            }
                            Trace.WriteLine($"令牌刷新成功，新 access_token: {access_token.Substring(0, 10)}...");
                            Trace.WriteLine("调用 GetUserInfo 获取最新用户信息...");
                            return await GetUserInfo(access_token, new_refresh_token);
                        }
                        else
                        {
                            Trace.WriteLine($"令牌刷新失败: {err}，响应内容: {result}");
                            throw new Exception(err);
                        }
                    }
                    else
                    {
                        Trace.WriteLine("无法解析令牌刷新响应（JObject 为空）");
                        throw new Exception("无法解析令牌刷新响应");
                    }
                }
                else
                {
                    Trace.WriteLine("令牌刷新响应结果为空字符串");
                    throw new Exception("令牌刷新响应为空");
                }
            }
            else
            {
                Trace.WriteLine($"令牌刷新HTTP失败: {response.StatusCode}，响应内容: {result}");
                throw new Exception($"令牌刷新HTTP请求失败: {response.StatusCode}");
            }
        }
    }
}
