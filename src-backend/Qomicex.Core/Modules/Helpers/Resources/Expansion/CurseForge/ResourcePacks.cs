using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using static Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge.CurseForgeBase;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class ResourcePacks : CurseForgeBase
    {
        public ResourcePacks(string ApiKey) : base(ApiKey, GetSearchUrl(), GetModUrl()) { }
        private static string GetSearchUrl()
        {
            return "/v1/mods/search?gameId=432&classId=12";
        }

        private static string GetModUrl()
        {
            return "/v1/mods/";
        }

        /// <summary>
        /// 获取推荐的ResourcePacks列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        public async Task<List<CurseForgeSearchResult>> GetRecommendResourcePacks(string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.GetRecommend(GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的ResourcePacks
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        public new async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.SearchAsync(SearchFilter, GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步获取指定ResourcePack的详细信息
        /// </summary>
        /// <param name="Id">ResourcePackId</param>
        /// <returns>ResourcePack信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<CurseForgeInfo> GetModInfoAsync(string Id)
        {
            return await base.GetInfoAsync(Id);
        }

        public enum Category
        {
            //enum不支持数字开头的名称，所以将数字后的x放到前面
            PhotoRealistic = 400,
            Steampunk = 399,
            Traditional = 403,
            x512AndHigher = 398,
            x128 = 396,
            x256 = 397,
            Medieval = 402,
            x64 = 395,
            Miscellaneous = 405,
            x32 = 394,
            x16 = 393,
            Animated = 404,
            Modern = 401,
            ModSupport = 4465,
            DataPacks = 5193,
            FontPacks = 5244,
        }
    }
}
