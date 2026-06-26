using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Account
{
    public class Yggdrasil : IDisposable
    {
        private readonly string _baseUrl; // base url
        private readonly string _email;
        private readonly string _password;
        private readonly HttpClient _httpClient;
        private readonly JsonSerializerOptions _jsonOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };
        private bool _disposed;

        private static class YggdrasilEndpoints
        {
            public const string Authenticate = "authserver/authenticate";
            public const string Refresh = "authserver/refresh";
            public const string Validate = "authserver/validate";
            public const string Invalidate = "authserver/invalidate";
        }

        /// <summary>
        /// Yggdrasil 的构造函数。
        /// </summary>
        /// <param name="baseUrl">用于身份验证的基础 URL。</param>
        /// <param name="email">账户的电子邮件地址。</param>
        /// <param name="password">账户的密码。</param>
        public Yggdrasil(string baseUrl, string email, string password)
        {
            if (string.IsNullOrWhiteSpace(baseUrl) || !Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
                throw new ArgumentException("Invalid base URL.", nameof(baseUrl));
            // 补全末尾的 "/"
            if (!uri.ToString().EndsWith("/"))
            {
                baseUrl = uri.ToString() + "/";
                uri = new Uri(baseUrl);
            }

            _baseUrl = baseUrl;
            _email = email ?? throw new ArgumentNullException(nameof(email));
            _password = password ?? throw new ArgumentNullException(nameof(password));

            _httpClient = new HttpClient
            {
                BaseAddress = uri,
                Timeout = TimeSpan.FromSeconds(30)
            };
            _httpClient.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/json"));
            Debug.WriteLine($"初始化Yggdrasil验证 - Base Url: {baseUrl}");
        }

        /// <summary>
        /// 使用提供的电子邮件和密码在 Yggdrasil 服务器上验证用户身份。
        /// </summary>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>与已验证用户关联的 Yggdrasil 账户列表。</returns>
        /// <exception cref="YggdrasilException">当身份验证失败时抛出。</exception>
        public async Task<List<YggdrasilAccount>> AuthenticateAsync(CancellationToken cancellationToken = default)
        {
            Debug.WriteLine("开始认证...");
            Debug.WriteLine("构建认证请求...");
            var request = new AuthenticateRequest
            {
                Username = _email,
                Password = _password,
                ClientToken = Guid.NewGuid().ToString("N"),
                RequestUser = true,
                Agent = new Agent
                {
                    Name = "Minecraft",
                    Version = 1
                }
            };
            Debug.WriteLine("执行联机验证...");
            var response = await _httpClient.PostAsJsonAsync(
                YggdrasilEndpoints.Authenticate,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<YggdrasilError>(_jsonOptions, cancellationToken);
                Debug.WriteLine($"认证失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new YggdrasilException(error?.ErrorMessage ?? $"认证失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }

            var authResponse = await response.Content.ReadFromJsonAsync<AuthenticateResponse>(_jsonOptions, cancellationToken);
            Debug.WriteLine("无法解析认证响应");
            if (authResponse == null)
                throw new YggdrasilException("无法解析认证响应");

            Debug.WriteLine("认证成功");
            return authResponse.AvailableProfiles?.Select(profile => new YggdrasilAccount
            {
                AccessToken = authResponse.AccessToken,
                ClientToken = authResponse.ClientToken,
                Uuid = profile.Id,
                Name = profile.Name,
                UserId = authResponse.User?.Id!,
                UserType = authResponse.User?.Properties?.FirstOrDefault(p => p.Name == "userType")?.Value!,
                IssuedAt = DateTimeOffset.Now,
                IsExpired = false
            }).ToList() ?? new List<YggdrasilAccount>();
        }

        /// <summary>
        /// 为指定的 Yggdrasil 账户刷新访问令牌。
        /// </summary>
        /// <param name="account">要刷新的 Yggdrasil 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>刷新后的 Yggdrasil 账户。</returns>
        /// <exception cref="YggdrasilException">当令牌刷新失败时抛出。</exception>
        public async Task<YggdrasilAccount> RefreshTokenAsync(YggdrasilAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));

            Debug.WriteLine($"开始刷新令牌: {account.Name}({account.Uuid})");
            var request = new RefreshRequest
            {
                AccessToken = account.AccessToken,
                ClientToken = account.ClientToken,
                RequestUser = true,
                SelectedProfile = new SelectedProfile
                {
                    Id = account.Uuid,
                    Name = account.Name
                }
            };
            Debug.WriteLine("执行令牌刷新...");
            var response = await _httpClient.PostAsJsonAsync(
                YggdrasilEndpoints.Refresh,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<YggdrasilError>(_jsonOptions, cancellationToken);
                Debug.WriteLine($"令牌刷新失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new YggdrasilException(error?.ErrorMessage ?? $"令牌刷新失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }

            var refreshResponse = await response.Content.ReadFromJsonAsync<RefreshResponse>(_jsonOptions, cancellationToken);
            if (refreshResponse == null)
            {
                Debug.WriteLine("无法解析令牌刷新响应");
                throw new YggdrasilException("无法解析令牌刷新响应");
            }
            Debug.WriteLine("令牌刷新成功");
            return new YggdrasilAccount
            {
                AccessToken = refreshResponse.AccessToken,
                ClientToken = refreshResponse.ClientToken,
                Uuid = refreshResponse.SelectedProfile?.Id!,
                Name = refreshResponse.SelectedProfile?.Name!,
                UserId = refreshResponse.User?.Id!,
                UserType = refreshResponse.User?.Properties?.FirstOrDefault(p => p.Name == "userType")?.Value!,
                IssuedAt = DateTimeOffset.Now,
                IsExpired = false
            };
        }

        /// <summary>
        /// 验证 Yggdrasil 账户中的令牌是否仍然有效。
        /// </summary>
        /// <param name="account">要验证的 Yggdrasil 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>如果令牌有效则返回 true；否则返回 false。</returns>
        /// <exception cref="YggdrasilException">在网络错误时抛出。</exception>
        public async Task<bool> ValidateTokenAsync(YggdrasilAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));
            Debug.WriteLine($"开始验证令牌: {account.Name}({account.Uuid})");
            var request = new ValidateRequest
            {
                AccessToken = account.AccessToken,
                ClientToken = account.ClientToken
            };

            try
            {
                Debug.WriteLine("执行令牌验证...");
                var response = await _httpClient.PostAsJsonAsync(
                    YggdrasilEndpoints.Validate,
                    request,
                    cancellationToken);
                Debug.WriteLine(response.IsSuccessStatusCode ? "令牌有效" : "令牌无效");
                return response.StatusCode == System.Net.HttpStatusCode.NoContent;
            }
            catch (HttpRequestException ex)
            {
                Debug.WriteLine($"网络错误导致令牌验证失败: {ex.Message}");
                throw new YggdrasilException("Failed to validate token due to network error.", ex);
            }
        }

        /// <summary>
        /// 使 Yggdrasil 账户中的令牌失效。
        /// </summary>
        /// <param name="account">要使令牌失效的 Yggdrasil 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <exception cref="YggdrasilException">当令牌失效操作失败时抛出。</exception>
        public async Task InvalidateTokenAsync(YggdrasilAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));
            Debug.WriteLine($"开始吊销令牌: {account.Name}({account.Uuid})");

            var request = new InvalidateRequest
            {
                AccessToken = account.AccessToken,
                ClientToken = account.ClientToken
            };

            Debug.WriteLine("执行令牌吊销...");

            var response = await _httpClient.PostAsJsonAsync(
                YggdrasilEndpoints.Invalidate,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<YggdrasilError>(_jsonOptions, cancellationToken);
                Debug.WriteLine($"令牌吊销失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new YggdrasilException(error?.ErrorMessage ?? $"令牌吊销失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }
        }

        public async Task<string?> GetSkinTextureAsync(string uuid, CancellationToken cancellationToken = default)
        {
            var url = $"{_baseUrl}/sessionserver/session/minecraft/profile/{uuid}";
            Debug.WriteLine($"获取皮肤: {url}");
            var response = await _httpClient.GetAsync(url, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<YggdrasilError>(_jsonOptions, cancellationToken);
                Debug.WriteLine($"获取皮肤失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new YggdrasilException(error?.ErrorMessage ?? $"获取皮肤失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error,
                    StatusCode = response.StatusCode
                };
            }

            var json = await response.Content.ReadFromJsonAsync<JsonElement>(_jsonOptions, cancellationToken);

            if (!json.TryGetProperty("properties", out var properties))
            {
                Debug.WriteLine("响应中不包含properties属性");
                return null;
            }

            if (properties.ValueKind != JsonValueKind.Array)
            {
                Debug.WriteLine("properties不是一个数组");
                return null;
            }

            foreach (var prop in properties.EnumerateArray())
            {
                if (!prop.TryGetProperty("name", out var nameProp) ||
                    nameProp.GetString() != "textures")
                {
                    continue;
                }

                if (prop.TryGetProperty("value", out var valueProp))
                {
                    var value = valueProp.GetString();
                    Debug.WriteLine("获取皮肤成功");
                    return GetSkinUrlFromTexture(value);
                }
            }

            Debug.WriteLine("未找到textures属性");
            return null;
        }
        private string? GetSkinUrlFromTexture(string? textureValue)
        {
            try
            {
                // 纹理值是Base64编码的JSON字符串
                byte[] textureBytes = Convert.FromBase64String(textureValue!);
                string textureJson = System.Text.Encoding.UTF8.GetString(textureBytes);

                var json = JsonDocument.Parse(textureJson);

                // 解析SKIN的URL
                if (json.RootElement.TryGetProperty("textures", out var textures) &&
                    textures.TryGetProperty("SKIN", out var skin) &&
                    skin.TryGetProperty("url", out var urlProp))
                {
                    return urlProp.GetString();
                }

                Debug.WriteLine("纹理数据中不包含SKIN URL");
                return null;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"解析皮肤URL失败: {ex.Message}");
                return null;
            }
        }


        public void Dispose()
        {
            if (!_disposed)
            {
                _httpClient?.Dispose();
                _disposed = true;
            }
        }

        /// <summary>
        /// 表示一个 Yggdrasil 身份验证游戏账户。
        /// </summary>
        public class YggdrasilAccount
        {
            /// <summary>
            /// 访问令牌。
            /// </summary>
            public string? AccessToken { get; set; }

            /// <summary>
            /// 客户端令牌。
            /// </summary>
            public string? ClientToken { get; set; }

            /// <summary>
            /// 角色 UUID（不含连字符）。
            /// </summary>
            public string? Uuid { get; set; }

            /// <summary>
            /// 角色名称。
            /// </summary>
            public string? Name { get; set; }

            /// <summary>
            /// 用户 ID。
            /// </summary>
            public string? UserId { get; set; }

            /// <summary>
            /// 用户类型。
            /// </summary>
            public string? UserType { get; set; }

            /// <summary>
            /// 令牌是否已过期。
            /// </summary>
            public bool IsExpired { get; set; }

            /// <summary>
            /// 令牌签发时间。
            /// </summary>
            public DateTimeOffset IssuedAt { get; set; } = DateTimeOffset.Now;

            /// <summary>
            /// 根据指定的有效期检查令牌是否过期。
            /// </summary>
            /// <param name="tokenLifetime">令牌的预期有效期。</param>
            /// <returns>如果已过期则返回 true，否则返回 false。</returns>
            public bool CheckExpiration(TimeSpan tokenLifetime)
            {
                IsExpired = DateTimeOffset.Now > IssuedAt.Add(tokenLifetime);
                return IsExpired;
            }
        }


        #region Internal Request/Response Models
        private class Agent
        {
            public string? Name { get; set; }
            public int Version { get; set; }
        }

        private class AuthenticateRequest
        {
            public string? Username { get; set; }
            public string? Password { get; set; }
            public string? ClientToken { get; set; }
            public bool RequestUser { get; set; }
            public Agent? Agent { get; set; }
        }

        private class AuthenticateResponse
        {
            public string? AccessToken { get; set; }
            public string? ClientToken { get; set; }
            public List<Profile>? AvailableProfiles { get; set; }
            public Profile? SelectedProfile { get; set; }
            public User? User { get; set; }
        }

        private class RefreshRequest
        {
            public string? AccessToken { get; set; }
            public string? ClientToken { get; set; }
            public bool RequestUser { get; set; }
            public SelectedProfile? SelectedProfile { get; set; }
        }

        private class RefreshResponse
        {
            public string? AccessToken { get; set; }
            public string? ClientToken { get; set; }
            public Profile? SelectedProfile { get; set; }
            public User? User { get; set; }
        }

        private class ValidateRequest
        {
            public string? AccessToken { get; set; }
            public string? ClientToken { get; set; }
        }

        private class InvalidateRequest
        {
            public string? AccessToken { get; set; }
            public string? ClientToken { get; set; }
        }

        private class Profile
        {
            public string? Id { get; set; }
            public string? Name { get; set; }
            public List<Property>? Properties { get; set; }
        }

        private class SelectedProfile
        {
            public string? Id { get; set; }
            public string? Name { get; set; }
        }

        private class User
        {
            public string? Id { get; set; }
            public List<Property>? Properties { get; set; }
        }

        private class Property
        {
            public string? Name { get; set; }
            public string? Value { get; set; }
            public string? Signature { get; set; }
        }

        private class YggdrasilError
        {
            public string? Error { get; set; }
            public string? ErrorMessage { get; set; }
            public string? Cause { get; set; }
        }
        #endregion
    }

    /// <summary>
    /// 与 Yggdrasil 身份验证相关的异常。
    /// </summary>
    public class YggdrasilException : Exception
    {
        /// <summary>
        /// 错误代码。
        /// </summary>
        public string? ErrorCode { get; set; } = string.Empty;

        /// <summary>
        /// HTTP 状态码。
        /// </summary>
        public System.Net.HttpStatusCode StatusCode { get; set; }

        /// <summary>
        /// 初始化 YggdrasilException 类的新实例。
        /// </summary>
        /// <param name="message">异常消息。</param>
        public YggdrasilException(string message) : base(message) { }

        /// <summary>
        /// 初始化 YggdrasilException 类的新实例，并指定内部异常。
        /// </summary>
        /// <param name="message">异常消息。</param>
        /// <param name="innerException">内部异常。</param>
        public YggdrasilException(string message, Exception innerException) : base(message, innerException) { }
    }
}
