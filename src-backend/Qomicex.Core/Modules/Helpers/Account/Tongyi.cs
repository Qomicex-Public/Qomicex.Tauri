using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Qomicex.Core.Modules.Helpers.Account
{
    public class Tongyi : IDisposable
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

        private static class TongyiEndpoints
        {
            public const string Authenticate = "authserver/authenticate";
            public const string Refresh = "authserver/refresh";
            public const string Validate = "authserver/validate";
            public const string Invalidate = "authserver/invalidate";
        }

        /// <summary>
        /// Tongyi 的构造函数。
        /// </summary>
        /// <param name="serverId">用于身份验证的基础 URL。</param>
        /// <param name="email">账户的电子邮件地址。</param>
        /// <param name="password">账户的密码。</param>
        public Tongyi(string serverId, string email, string password)
        {
            var baseUrl = $"https://auth.mc-user.com:233/{serverId}" ?? throw new ArgumentNullException(nameof(serverId));
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
        }
        /// <summary>
        /// 使用提供的电子邮件和密码在 统一通行证 上验证用户身份。
        /// </summary>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>与已验证用户关联的 统一通行证 账户列表。</returns>
        /// <exception cref="TongyiException">当身份验证失败时抛出。</exception>
        public async Task<List<TongyiAccount>> AuthenticateAsync(CancellationToken cancellationToken = default)
        {
            Trace.WriteLine("开始认证...");
            Trace.WriteLine("构建认证请求...");
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
            Trace.WriteLine("执行联机验证...");
            var response = await _httpClient.PostAsJsonAsync(
                TongyiEndpoints.Authenticate,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<TongyiError>(_jsonOptions, cancellationToken);
                Trace.WriteLine($"认证失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new TongyiException(error?.ErrorMessage ?? $"认证失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }

            var authResponse = await response.Content.ReadFromJsonAsync<AuthenticateResponse>(_jsonOptions, cancellationToken);
            if (authResponse == null)
            {
                Trace.WriteLine("无法解析认证响应");
                throw new TongyiException("无法解析认证响应");
            }

            Trace.WriteLine("认证成功");
            return authResponse.AvailableProfiles?.Select(profile => new TongyiAccount
            {
                AccessToken = authResponse.AccessToken,
                ClientToken = authResponse.ClientToken,
                Uuid = profile.Id,
                Name = profile.Name,
                UserId = authResponse.User?.Id!,
                UserType = authResponse.User?.Properties?.FirstOrDefault(p => p.Name == "userType")?.Value!,
                IssuedAt = DateTimeOffset.Now,
                IsExpired = false
            }).ToList() ?? new List<TongyiAccount>();
        }

        /// <summary>
        /// 为指定的 统一通行证 账户刷新访问令牌。
        /// </summary>
        /// <param name="account">要刷新的 统一通行证 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>刷新后的 统一通行证 账户。</returns>
        /// <exception cref="TongyiException">当令牌刷新失败时抛出。</exception>
        public async Task<TongyiAccount> RefreshTokenAsync(TongyiAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));

            Trace.WriteLine($"开始刷新令牌: {account.Name}({account.Uuid})");
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

            Trace.WriteLine("执行令牌刷新...");
            var response = await _httpClient.PostAsJsonAsync(
                TongyiEndpoints.Refresh,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<TongyiError>(_jsonOptions, cancellationToken);
                Trace.WriteLine($"令牌刷新失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new TongyiException(error?.ErrorMessage ?? $"令牌刷新失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }

            var refreshResponse = await response.Content.ReadFromJsonAsync<RefreshResponse>(_jsonOptions, cancellationToken);
            if (refreshResponse == null)
            {
                Trace.WriteLine("无法解析令牌刷新响应");
                throw new TongyiException("无法解析令牌刷新响应");
            }

            Trace.WriteLine("令牌刷新成功");
            return new TongyiAccount
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
        /// 验证 统一通行证 账户中的令牌是否仍然有效。
        /// </summary>
        /// <param name="account">要验证的 统一通行证 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <returns>如果令牌有效则返回 true；否则返回 false。</returns>
        /// <exception cref="TongyiException">在网络错误时抛出。</exception>
        public async Task<bool> ValidateTokenAsync(TongyiAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));

            Trace.WriteLine($"开始验证令牌: {account.Name}({account.Uuid})");
            var request = new ValidateRequest
            {
                AccessToken = account.AccessToken,
                ClientToken = account.ClientToken
            };

            try
            {
                Trace.WriteLine("执行令牌验证...");
                var response = await _httpClient.PostAsJsonAsync(
                    TongyiEndpoints.Validate,
                    request,
                    cancellationToken);

                Trace.WriteLine(response.IsSuccessStatusCode ? "令牌有效" : "令牌无效");
                return response.StatusCode == System.Net.HttpStatusCode.NoContent;
            }
            catch (HttpRequestException ex)
            {
                Trace.WriteLine($"网络错误导致令牌验证失败: {ex.Message}");
                throw new TongyiException("Failed to validate token due to network error.", ex);
            }
        }

        /// <summary>
        /// 使 统一通行证 账户中的令牌失效。
        /// </summary>
        /// <param name="account">要使令牌失效的 统一通行证 账户。</param>
        /// <param name="cancellationToken">用于取消异步操作的令牌。</param>
        /// <exception cref="TongyiException">当令牌失效操作失败时抛出。</exception>
        public async Task InvalidateTokenAsync(TongyiAccount account, CancellationToken cancellationToken = default)
        {
            if (account == null)
                throw new ArgumentNullException(nameof(account));

            Trace.WriteLine($"开始吊销令牌: {account.Name}({account.Uuid})");
            var request = new InvalidateRequest
            {
                AccessToken = account.AccessToken,
                ClientToken = account.ClientToken
            };

            Trace.WriteLine("执行令牌吊销...");
            var response = await _httpClient.PostAsJsonAsync(
                TongyiEndpoints.Invalidate,
                request,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<TongyiError>(_jsonOptions, cancellationToken);
                Trace.WriteLine($"令牌吊销失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new TongyiException(error?.ErrorMessage ?? $"令牌吊销失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }
        }
        public async Task<string?> GetSkinTextureAsync(string uuid, CancellationToken cancellationToken = default)
        {
            // 使用相对路径，BaseAddress 已包含服务器 ID
            var url = $"sessionserver/session/minecraft/profile/{uuid}";
            Trace.WriteLine($"获取皮肤: {_baseUrl}{url}");
            var response = await _httpClient.GetAsync(url, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadFromJsonAsync<TongyiError>(_jsonOptions, cancellationToken);
                Trace.WriteLine($"获取皮肤失败(Code:{response.StatusCode}):{error?.ErrorMessage}");
                throw new TongyiException(error?.ErrorMessage ?? $"获取皮肤失败: {response.StatusCode}")
                {
                    ErrorCode = error?.Error!,
                    StatusCode = response.StatusCode
                };
            }

            var json = await response.Content.ReadFromJsonAsync<JsonElement>(_jsonOptions, cancellationToken);
            var properties = json.GetProperty("properties");
            foreach (var prop in properties.EnumerateArray())
            {
                if (prop.GetProperty("name").GetString() == "textures")
                {
                    Trace.WriteLine("获取皮肤成功");
                    return prop.GetProperty("value").GetString();
                }

            }
            return null;
        }

        public void OpenRegisterPage(string ServerID)
        {
            var url = $"https://login.mc-user.com:233/{ServerID}/loginreg";
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                throw new TongyiException($"无法打开注册页面: {ex.Message}");
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
        /// 表示一个 统一通行证 身份验证游戏账户。
        /// </summary>
        public class TongyiAccount
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

        private class TongyiError
        {
            public string? Error { get; set; }
            public string? ErrorMessage { get; set; }
            public string? Cause { get; set; }
        }
        #endregion
    }

    /// <summary>
    /// 与 统一通行证 身份验证相关的异常。
    /// </summary>
    public class TongyiException : Exception
    {
        /// <summary>
        /// 错误代码。
        /// </summary>
        public string ErrorCode { get; set; } = string.Empty;

        /// <summary>
        /// HTTP 状态码。
        /// </summary>
        public System.Net.HttpStatusCode StatusCode { get; set; }

        /// <summary>
        /// 初始化 统一通行证Exception 类的新实例。
        /// </summary>
        /// <param name="message">异常消息。</param>
        public TongyiException(string message) : base(message) { }

        /// <summary>
        /// 初始化 统一通行证Exception 类的新实例，并指定内部异常。
        /// </summary>
        /// <param name="message">异常消息。</param>
        /// <param name="innerException">内部异常。</param>
        public TongyiException(string message, Exception innerException) : base(message, innerException) { }
    }
}
